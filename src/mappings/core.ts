/* eslint-disable prefer-const */
import { log, BigInt, BigDecimal, store, Address, Bytes } from '@graphprotocol/graph-ts'
import {
  Pair,
  Token,
  UniswapFactory,
  Transaction,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
  Bundle
} from '../../generated/schema'
import {
  Pair as PairContract,
  Mint,
  Burn,
  Swap,
  Transfer,
  Sync,
  FeePercentUpdated,
  SetStableSwap
} from '../../generated/templates/Pair/Pair'
import { updatePairDayData, updateTokenDayData, updateUniswapDayData, updatePairHourData } from './dayUpdates'
import { getEthPriceInUSD, findEthPerToken, getTrackedVolumeUSD, getTrackedLiquidityUSD } from './pricing'
import {
  convertTokenToDecimal,
  ADDRESS_ZERO,
  FACTORY_ADDRESS,
  ONE_BI,
  createUser,
  createLiquidityPosition,
  ZERO_BD,
  BI_18,
  createLiquiditySnapshot, exponentToBigDecimal, exponentToBigInt
} from './helpers'

let BLACKLISTED_PAIRS: string[] = []

function isCompleteMint(mintId: string): boolean {
  const mint = MintEvent.load(mintId)
  if (mint) {
    return mint.sender !== null;
  }

  return false
  // return MintEvent.load(mintId).sender !== null // sufficient checks
}

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.value.equals(BigInt.fromI32(1000))) {
    return
  }

  let factory = UniswapFactory.load(FACTORY_ADDRESS)
  if (factory) {
    log.warning(`[===prince===] FACTORY_ADDRESS if ${factory.id}`, [``])
  } else {
    log.warning(`[===prince===] FACTORY_ADDRESS null`, [``])
  }
  let transactionHash = event.transaction.hash.toHexString()

  // user stats
  let from = event.params.from
  createUser(from)
  let to = event.params.to
  createUser(to)

  // get pair and load contract
  let pair = Pair.load(event.address.toHexString())
  if (pair) {
    log.warning(`[===prince===] Pair.load ${event.address.toHex()}`, [``])
  } else {
    log.warning(`[===prince===] Pair.load pair is null`, [``])
  }
  // TODO: BLACKLIST PAIRS
  if (pair && BLACKLISTED_PAIRS.includes(pair.id)) return

  let pairContract = PairContract.bind(event.address)

  // liquidity token amount being transfered
  let value = convertTokenToDecimal(event.params.value, BI_18)

  // get or create transaction
  let transaction = Transaction.load(transactionHash)
  if (transaction === null) {
    transaction = new Transaction(transactionHash)
    transaction.blockNumber = event.block.number
    transaction.timestamp = event.block.timestamp
    transaction.mints = []
    transaction.burns = []
    transaction.swaps = []
  }

  // mints
  let mints = transaction.mints
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    if (pair) {
      pair.totalSupply = pair.totalSupply.plus(value)
      pair.save()
    }

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(mints.length).toString())
      )
      mint.transaction = transaction.id
      if (pair) {
        mint.pair = pair.id
      }
      mint.to = to
      mint.liquidity = value
      mint.timestamp = transaction.timestamp
      mint.transaction = transaction.id
      mint.save()

      // update mints in transaction
      transaction.mints = mints.concat([mint.id])

      // save entities
      transaction.save()
      if (factory) {
        factory.save()
      }
    }
  }

  // case where direct send first on ETH withdrawls
  if (pair && event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns
    let burn = new BurnEvent(
      event.transaction.hash
        .toHexString()
        .concat('-')
        .concat(BigInt.fromI32(burns.length).toString())
    )
    burn.transaction = transaction.id
    burn.pair = pair.id
    burn.liquidity = value
    burn.timestamp = transaction.timestamp
    burn.to = event.params.to
    burn.sender = event.params.from
    burn.needsComplete = true
    burn.transaction = transaction.id
    burn.save()

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id)
    transaction.burns = burns
    transaction.save()
  }

  // burn
  if (pair && event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value)
    pair.save()

    // this is a new instance of a logical burn
    let burns = transaction.burns
    let burn: BurnEvent
    if (burns.length > 0) {
      let currentBurn = BurnEvent.load(burns[burns.length - 1])
      if (currentBurn && currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent
      } else {
        burn = new BurnEvent(
          event.transaction.hash
            .toHexString()
            .concat('-')
            .concat(BigInt.fromI32(burns.length).toString())
        )
        burn.transaction = transaction.id
        burn.needsComplete = false
        burn.pair = pair.id
        burn.liquidity = value
        burn.transaction = transaction.id
        burn.timestamp = transaction.timestamp
      }
    } else {
      burn = new BurnEvent(
        event.transaction.hash
          .toHexString()
          .concat('-')
          .concat(BigInt.fromI32(burns.length).toString())
      )
      burn.transaction = transaction.id
      burn.needsComplete = false
      burn.pair = pair.id
      burn.liquidity = value
      burn.transaction = transaction.id
      burn.timestamp = transaction.timestamp
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1])
      if (mint) {
        burn.feeTo = mint.to
        burn.feeLiquidity = mint.liquidity
      }
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1])
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop()
      transaction.mints = mints
      transaction.save()
    }
    burn.save()
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id)
    }
    transaction.burns = burns
    transaction.save()
  }

  if (pair && from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from)
    fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), BI_18)
    fromUserLiquidityPosition.save()
    createLiquiditySnapshot(fromUserLiquidityPosition, event)
  }

  if (pair && event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to)
    toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), BI_18)
    toUserLiquidityPosition.save()
    createLiquiditySnapshot(toUserLiquidityPosition, event)
  }

  transaction.save()
}

export function handleSync(event: Sync): void {
  let pair = Pair.load(event.address.toHex())
  if (pair) {
    log.warning(`[===prince===] Pair.load ${event.address.toHex()}`, [``])
  } else {
    log.warning(`[===prince===] Pair.load pair is null`, [``])
  }
  if (pair) {
    // TODO: BLACKLIST PAIRS
    if (BLACKLISTED_PAIRS.includes(pair.id)) return

    let pairContract = PairContract.bind(event.address)

    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
    if (uniswap) {
      log.warning(`[===prince===] FACTORY_ADDRESS if ${uniswap.id}`, [``])
    } else {
      log.warning(`[===prince===] FACTORY_ADDRESS null`, [``])
    }
    if (uniswap) {
      // reset factory liquidity by subtracting onluy tarcked liquidity
      uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.minus(pair.trackedReserveETH as BigDecimal)
    }

    if (token0 && token1) {
      // reset token total liquidity amounts
      token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0)
      token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1)

      pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals)
      pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals)
    }

    // TODO
    if (pair.reserve1.notEqual(ZERO_BD)) pair.token0Price = pair.reserve0.div(pair.reserve1)
    else pair.token0Price = ZERO_BD
    // TODO
    if (pair.reserve0.notEqual(ZERO_BD)) pair.token1Price = pair.reserve1.div(pair.reserve0)
    else pair.token1Price = ZERO_BD

    pair.save()

    // update ETH price now that reserves could have changed
    let bundle = Bundle.load('1')
    if (bundle) {
      log.info("[===prince===] old bundle", [bundle.ethPrice.toString()])
      bundle.ethPrice = getEthPriceInUSD()
      bundle.save()
    } else {
      log.info("[===prince===] new bundle 0", ['old'])
      bundle = new Bundle('1');
      log.info("[===prince===] new bundle 1", [`new`])
      bundle.ethPrice = getEthPriceInUSD()
      log.info("[===prince===] new bundle 2", [bundle.ethPrice.toString()])
      bundle.save()
    }

    if (token0 && token1 && bundle && uniswap) {
      token0.derivedETH = findEthPerToken(token0 as Token)
      token1.derivedETH = findEthPerToken(token1 as Token)
      token0.save()
      token1.save()

      // get tracked liquidity - will be 0 if neither is in whitelist
      let trackedLiquidityETH: BigDecimal
      if (bundle.ethPrice.notEqual(ZERO_BD)) {
        trackedLiquidityETH = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(
          bundle.ethPrice
        )
      } else {
        trackedLiquidityETH = ZERO_BD
      }

      // use derived amounts within pair
      pair.trackedReserveETH = trackedLiquidityETH
      pair.reserveETH = pair.reserve0
        .times(token0.derivedETH as BigDecimal)
        .plus(pair.reserve1.times(token1.derivedETH as BigDecimal))
      pair.reserveUSD = pair.reserveETH.times(bundle.ethPrice)

      // use tracked amounts globally
      uniswap.totalLiquidityETH = uniswap.totalLiquidityETH.plus(trackedLiquidityETH)
      uniswap.totalLiquidityUSD = uniswap.totalLiquidityETH.times(bundle.ethPrice)

      // now correctly set liquidity amounts for each token
      token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0)
      token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1)

      // save entities
      pair.save()
      uniswap.save()
      token0.save()
      token1.save()
    }
  }
}

export function handleMint(event: Mint): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())
  if (transaction) {
    let mints = transaction.mints
    let mint = MintEvent.load(mints[mints.length - 1])

    let pair = Pair.load(event.address.toHex())
    if (pair) {
      log.warning(`[===prince===] Pair.load ${event.address.toHex()}`, [``])
    } else {
      log.warning(`[===prince===] Pair.load pair is null`, [``])
    }
    let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
    if (uniswap) {
      log.warning(`[===prince===] FACTORY_ADDRESS if ${uniswap.id}`, [``])
    } else {
      log.warning(`[===prince===] FACTORY_ADDRESS null`, [``])
    }
    if (pair && uniswap) {

      let token0 = Token.load(pair.token0)
      let token1 = Token.load(pair.token1)
      if (token0 && token1) {

        // update exchange info (except balances, sync will cover that)
        let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
        let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

        // update txn counts
        token0.txCount = token0.txCount.plus(ONE_BI)
        token1.txCount = token1.txCount.plus(ONE_BI)

        // get new amounts of USD and ETH for tracking
        let bundle = Bundle.load('1')
        if (mint) {
          if (token1.derivedETH && token0.derivedETH && bundle) {
            let amountTotalUSD = (token1.derivedETH as BigDecimal)
              .times(token1Amount)
              .plus((token0.derivedETH as BigDecimal).times(token0Amount))
              .times(bundle.ethPrice)
            mint.amountUSD = amountTotalUSD as BigDecimal
            log.warning(`[===prince===] mint.amountUSD ${(mint.amountUSD as BigDecimal).toString()}`, [``])
          }

          // TODO: AMOUNT TOO LOW
          // if(amountTotalUSD < BigDecimal.fromString('0.000004') ) {
          //   // DO NOT MANAGE TOO LOW MINT
          //   return
          // }

          // update txn counts
          pair.txCount = pair.txCount.plus(ONE_BI)
          uniswap.txCount = uniswap.txCount.plus(ONE_BI)

          // save entities
          token0.save()
          token1.save()
          pair.save()
          uniswap.save()

          mint.sender = event.params.sender
          mint.amount0 = token0Amount as BigDecimal
          mint.amount1 = token1Amount as BigDecimal
          mint.logIndex = event.logIndex
          // mint.amountUSD = amountTotalUSD as BigDecimal

          log.warning(`[===prince===] mint.sender ${(mint.sender as Bytes).toHexString()}`, [``])
          log.warning(`[===prince===] mint.amount0 ${(mint.amount0 as BigDecimal).toString()}`, [``])
          log.warning(`[===prince===] mint.amount1 ${(mint.amount1 as BigDecimal).toString()}`, [``])
          log.warning(`[===prince===] mint.logIndex ${(mint.logIndex as BigInt).toString()}`, [``])

          mint.save()

          // update the LP position
          let liquidityPosition = createLiquidityPosition(event.address, Address.fromBytes(mint.to))
          createLiquiditySnapshot(liquidityPosition, event)

          // update day entities
          updatePairDayData(event)
          updatePairHourData(event)
          updateUniswapDayData(event)
          updateTokenDayData(token0 as Token, event)
          updateTokenDayData(token1 as Token, event)
        }
      }

    }

  }
}

export function handleBurn(event: Burn): void {
  let transaction = Transaction.load(event.transaction.hash.toHexString())

  // safety check
  if (transaction === null) {
    return
  }

  let burns = transaction.burns
  let burn = BurnEvent.load(burns[burns.length - 1])

  let pair = Pair.load(event.address.toHex())
  if (pair) {
    log.warning(`[===prince===] Pair.load ${event.address.toHex()}`, [``])
  } else {
    log.warning(`[===prince===] Pair.load pair is null`, [``])
  }
  // TODO: BLACKLIST PAIRS
  if (pair && BLACKLISTED_PAIRS.includes(pair.id)) return

  let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
  if (uniswap) {
    log.warning(`[===prince===] FACTORY_ADDRESS if ${uniswap.id}`, [``])
  } else {
    log.warning(`[===prince===] FACTORY_ADDRESS null`, [``])
  }

  if (pair && burn) {

    //update token info
    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    if (token0 && token1 && token0.derivedETH && token1.derivedETH && uniswap) {

      let token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals)
      let token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals)

      // update txn counts
      token0.txCount = token0.txCount.plus(ONE_BI)
      token1.txCount = token1.txCount.plus(ONE_BI)

      // get new amounts of USD and ETH for tracking
      let bundle = Bundle.load('1')
      if (bundle) {

        let amountTotalUSD = (token1.derivedETH as BigDecimal)
          .times(token1Amount)
          .plus((token0.derivedETH as BigDecimal).times(token0Amount))
          .times(bundle.ethPrice)

        // update txn counts
        uniswap.txCount = uniswap.txCount.plus(ONE_BI)
        pair.txCount = pair.txCount.plus(ONE_BI)

        // update global counter and save
        token0.save()
        token1.save()
        pair.save()
        uniswap.save()

        // update burn
        // burn.sender = event.params.sender
        burn.amount0 = token0Amount as BigDecimal
        burn.amount1 = token1Amount as BigDecimal
        // burn.to = event.params.to
        burn.logIndex = event.logIndex
        burn.amountUSD = amountTotalUSD as BigDecimal
        burn.save()

        // update the LP position
        let liquidityPosition = createLiquidityPosition(event.address, Address.fromBytes(burn.sender as Bytes))
        createLiquiditySnapshot(liquidityPosition, event)

        // update day entities
        updatePairDayData(event)
        updatePairHourData(event)
        updateUniswapDayData(event)
        updateTokenDayData(token0 as Token, event)
        updateTokenDayData(token1 as Token, event)
      }
    }
  }
}

export function handleSwap(event: Swap): void {
  let pair = Pair.load(event.address.toHexString())
  if (pair) {
    log.warning(`[===prince===] Pair.load ${event.address.toHexString()}`, [``])
  } else {
    log.warning(`[===prince===] Pair.load pair is null`, [``])
  }
  if (pair) {
    // TODO: BLACKLIST PAIRS
    if (BLACKLISTED_PAIRS.includes(pair.id)) return

    let token0 = Token.load(pair.token0)
    let token1 = Token.load(pair.token1)
    if (token0 && token1 && token0.derivedETH && token1.derivedETH) {

      let amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals)
      let amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals)
      let amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals)
      let amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals)

      // totals for volume updates
      let amount0Total = amount0Out.plus(amount0In)
      let amount1Total = amount1Out.plus(amount1In)

      // ETH/USD prices
      let bundle = Bundle.load('1')
      if (bundle) {

        // get total amounts of derived USD and ETH for tracking
        let derivedAmountETH = (token1.derivedETH as BigDecimal)
          .times(amount1Total)
          .plus((token0.derivedETH as BigDecimal).times(amount0Total))
          .div(BigDecimal.fromString('2'))
        let derivedAmountUSD = derivedAmountETH.times(bundle.ethPrice)

        // TODO: AMOUNT TOO LOW
        // if(derivedAmountETH < BigDecimal.fromString('0.000002') ) {
        //   // DO NOT MANAGE TOO LOW SWAP
        //   return
        // }

        // get total swap fee of derived USD and ETH for tracking
        let feeAmountETH = (token1.derivedETH as BigDecimal).times(amount1In).times(pair.token1FeePercent)
          .plus((token0.derivedETH as BigDecimal).times(amount0In).times(pair.token0FeePercent)).div(BigDecimal.fromString('100'))
        let feeAmountUSD = feeAmountETH.times(bundle.ethPrice)

        // only accounts for volume through white listed tokens
        let trackedAmountUSD = getTrackedVolumeUSD(amount0Total, token0 as Token, amount1Total, token1 as Token, pair as Pair)

        let trackedAmountETH: BigDecimal
        if (bundle.ethPrice.equals(ZERO_BD)) {
          trackedAmountETH = ZERO_BD
        } else {
          trackedAmountETH = trackedAmountUSD.div(bundle.ethPrice)
        }

        // update token0 global volume and token liquidity stats
        token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out))
        token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD)
        token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD)

        // update token1 global volume and token liquidity stats
        token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out))
        token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD)
        token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD)

        // update txn counts
        token0.txCount = token0.txCount.plus(ONE_BI)
        token1.txCount = token1.txCount.plus(ONE_BI)

        // update pair volume data, use tracked amount if we have it as its probably more accurate
        pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD)
        pair.feeUSD = pair.feeUSD.plus(feeAmountUSD)
        pair.volumeToken0 = pair.volumeToken0.plus(amount0Total)
        pair.volumeToken1 = pair.volumeToken1.plus(amount1Total)
        pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD)
        pair.txCount = pair.txCount.plus(ONE_BI)
        pair.save()

        // update global values, only used tracked amounts for volume
        let uniswap = UniswapFactory.load(FACTORY_ADDRESS)
        if (uniswap) {
          log.warning(`[===prince===] FACTORY_ADDRESS if ${uniswap.id}`, [``])
        } else {
          log.warning(`[===prince===] FACTORY_ADDRESS null`, [``])
        }
        if (uniswap) {

          uniswap.totalVolumeUSD = uniswap.totalVolumeUSD.plus(trackedAmountUSD)
          uniswap.totalVolumeETH = uniswap.totalVolumeETH.plus(trackedAmountETH)
          uniswap.untrackedVolumeUSD = uniswap.untrackedVolumeUSD.plus(derivedAmountUSD)
          uniswap.totalFeeUSD = uniswap.totalFeeUSD.plus(feeAmountUSD)
          uniswap.totalFeeETH = uniswap.totalFeeETH.plus(feeAmountETH)
          uniswap.txCount = uniswap.txCount.plus(ONE_BI)

          // save entities
          pair.save()
          token0.save()
          token1.save()
          uniswap.save()

          let transaction = Transaction.load(event.transaction.hash.toHexString())
          if (transaction === null) {
            transaction = new Transaction(event.transaction.hash.toHexString())
            transaction.blockNumber = event.block.number
            transaction.timestamp = event.block.timestamp
            transaction.mints = []
            transaction.swaps = []
            transaction.burns = []
          }
          let swaps = transaction.swaps
          let swap = new SwapEvent(
            event.transaction.hash
              .toHexString()
              .concat('-')
              .concat(BigInt.fromI32(swaps.length).toString())
          )

          // update swap event
          swap.transaction = transaction.id
          swap.pair = pair.id
          swap.timestamp = transaction.timestamp
          swap.transaction = transaction.id
          swap.sender = event.params.sender
          swap.amount0In = amount0In
          swap.amount1In = amount1In
          swap.amount0Out = amount0Out
          swap.amount1Out = amount1Out
          swap.to = event.params.to
          swap.from = event.transaction.from
          swap.logIndex = event.logIndex
          // use the tracked amount if we have it
          swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD
          swap.save()

          // update the transaction

          // TODO: Consider using .concat() for handling array updates to protect
          // against unintended side effects for other code paths.
          swaps.push(swap.id)
          transaction.swaps = swaps
          transaction.save()

          // update day entities
          let pairDayData = updatePairDayData(event)
          let pairHourData = updatePairHourData(event)
          let uniswapDayData = updateUniswapDayData(event)
          let token0DayData = updateTokenDayData(token0 as Token, event)
          let token1DayData = updateTokenDayData(token1 as Token, event)

          // swap specific updating
          uniswapDayData.dailyVolumeUSD = uniswapDayData.dailyVolumeUSD.plus(trackedAmountUSD)
          uniswapDayData.dailyVolumeETH = uniswapDayData.dailyVolumeETH.plus(trackedAmountETH)
          uniswapDayData.dailyFeeETH = uniswapDayData.dailyFeeETH.plus(feeAmountETH)
          uniswapDayData.dailyFeeUSD = uniswapDayData.dailyFeeUSD.plus(feeAmountUSD)
          uniswapDayData.dailyVolumeUntracked = uniswapDayData.dailyVolumeUntracked.plus(derivedAmountUSD)
          uniswapDayData.save()

          // swap specific updating for pair
          pairDayData.dailyVolumeToken0 = pairDayData.dailyVolumeToken0.plus(amount0Total)
          pairDayData.dailyVolumeToken1 = pairDayData.dailyVolumeToken1.plus(amount1Total)
          pairDayData.dailyVolumeUSD = pairDayData.dailyVolumeUSD.plus(trackedAmountUSD)
          pairDayData.dailyFeeUSD = pairDayData.dailyFeeUSD.plus(feeAmountUSD)
          pairDayData.save()

          // update hourly pair data
          pairHourData.hourlyVolumeToken0 = pairHourData.hourlyVolumeToken0.plus(amount0Total)
          pairHourData.hourlyVolumeToken1 = pairHourData.hourlyVolumeToken1.plus(amount1Total)
          pairHourData.hourlyVolumeUSD = pairHourData.hourlyVolumeUSD.plus(trackedAmountUSD)
          pairHourData.save()

          // swap specific updating for token0
          token0DayData.dailyVolumeToken = token0DayData.dailyVolumeToken.plus(amount0Total)
          token0DayData.dailyVolumeETH = token0DayData.dailyVolumeETH.plus(amount0Total.times(token0.derivedETH as BigDecimal))
          token0DayData.dailyVolumeUSD = token0DayData.dailyVolumeUSD.plus(
            amount0Total.times(token0.derivedETH as BigDecimal).times(bundle.ethPrice)
          )
          token0DayData.save()

          // swap specific updating
          token1DayData.dailyVolumeToken = token1DayData.dailyVolumeToken.plus(amount1Total)
          token1DayData.dailyVolumeETH = token1DayData.dailyVolumeETH.plus(amount1Total.times(token1.derivedETH as BigDecimal))
          token1DayData.dailyVolumeUSD = token1DayData.dailyVolumeUSD.plus(
            amount1Total.times(token1.derivedETH as BigDecimal).times(bundle.ethPrice)
          )
          token1DayData.save()
        }
      }

    }
  }
}

export function handleTypeSwitch(event: SetStableSwap): void {
  let pair = Pair.load(event.address.toHexString())
  if (pair) {
    log.warning(`[===prince===] Pair.load ${event.address.toHexString()}`, [``])
  } else {
    log.warning(`[===prince===] Pair.load pair is null`, [``])
  }
  if (pair) {
    // TODO: BLACKLIST PAIRS
    if (BLACKLISTED_PAIRS.includes(pair.id)) return
    pair.isStable = event.params.stableSwap
    pair.save()
  }
}

export function handleFeePercentUpdated(event: FeePercentUpdated): void {
  let pair = Pair.load(event.address.toHexString())
  if (pair) {
    log.warning(`[===prince===] Pair.load ${event.address.toHexString()}`, [``])
  } else {
    log.warning(`[===prince===] Pair.load pair is null`, [``])
  }
  // TODO: BLACKLIST PAIRS
  if (pair) {
    if (BLACKLISTED_PAIRS.includes(pair.id)) return

    pair.token0Fee = BigInt.fromI32(event.params.token0FeePercent)
    pair.token1Fee = BigInt.fromI32(event.params.token1FeePercent)
    pair.token0FeePercent = BigInt.fromI32(event.params.token0FeePercent).toBigDecimal().div(BigDecimal.fromString('1000'))
    pair.token1FeePercent = BigInt.fromI32(event.params.token1FeePercent).toBigDecimal().div(BigDecimal.fromString('1000'))
    pair.save()
  }
}