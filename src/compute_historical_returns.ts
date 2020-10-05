/**
 * formats data for historical chart for an LPs position in 1 pair over time
 * @param startDateTimestamp // day to start tracking at
 * @param currentPairData // current stat of the pair
 * @param pairSnapshots // history of entries and exits for lp on this pair
 * @param currentETHPrice // current price of eth used for usd conversions
 */
import {getMetricsForPositionWindow} from "./compute-returns";
import dayjs from "dayjs";
import {gql} from "graphql-request";

export async function getHistoricalPairReturns(startDateTimestamp, currentPairData, pairSnapshots, currentETHPrice) {
    // catch case where data not puplated yet
    if (!currentPairData.createdAtTimestamp) {
        return []
    }
    let dayIndex: number = Math.round(startDateTimestamp / 86400) // get unique day bucket unix
    const currentDayIndex: number = Math.round(dayjs.utc().unix() / 86400)
    let sortedPositions = pairSnapshots.sort((a, b) => {
        // Sort pairs by timestamp
        return parseInt(a.timestamp) > parseInt(b.timestamp) ? 1 : -1
    })
    if (sortedPositions[0].timestamp > startDateTimestamp) {
        dayIndex = Math.round(sortedPositions[0].timestamp / 86400)
    }

    const dayTimestamps = []
    while (dayIndex < currentDayIndex) {
        // only account for days where this pair existed
        if (dayIndex * 86400 >= parseInt(currentPairData.createdAtTimestamp)) {
            dayTimestamps.push(dayIndex * 86400)
        }
        dayIndex = dayIndex + 1
    }

    const shareValues = await getShareValueOverTime(currentPairData.id, dayTimestamps)
    const shareValuesFormatted = {}
    shareValues?.map(share => {
        shareValuesFormatted[share.timestamp] = share
    })

    // set the default position and data
    let positionT0 = pairSnapshots[0]
    const formattedHistory = []
    let netFees = 0

    // keep track of up to date metrics as we parse each day
    for (const index in dayTimestamps) {
        // get the bounds on the day
        const dayTimestamp = dayTimestamps[index]
        const timestampCeiling = dayTimestamp + 86400

        // for each change in position value that day, create a window and update
        const dailyChanges = pairSnapshots.filter(snapshot => {
            return snapshot.timestamp < timestampCeiling && snapshot.timestamp > dayTimestamp
        })
        for (let i = 0; i < dailyChanges.length; i++) {
            const positionT1 = dailyChanges[i]
            const localReturns = getMetricsForPositionWindow(positionT0, positionT1)
            netFees = netFees + localReturns.fees
            positionT0 = positionT1
        }

        // now treat the end of the day as a hypothetical position
        let positionT1 = shareValuesFormatted[dayTimestamp + 86400]
        if (!positionT1) {
            positionT1 = {
                pair: currentPairData.id,
                liquidityTokenBalance: positionT0.liquidityTokenBalance,
                totalSupply: currentPairData.totalSupply,
                reserve0: currentPairData.reserve0,
                reserve1: currentPairData.reserve1,
                reserveUSD: currentPairData.reserveUSD,
                token0PriceUSD: currentPairData.token0.derivedETH * currentETHPrice,
                token1PriceUSD: currentPairData.token1.derivedETH * currentETHPrice
            }
        }

        if (positionT1) {
            positionT1.liquidityTokenTotalSupply = positionT1.totalSupply
            positionT1.liquidityTokenBalance = positionT0.liquidityTokenBalance
            const currentLiquidityValue =
                (parseFloat(positionT1.liquidityTokenBalance) / parseFloat(positionT1.liquidityTokenTotalSupply)) *
                parseFloat(positionT1.reserveUSD)
            const localReturns = getMetricsForPositionWindow(positionT0, positionT1)
            const localFees = netFees + localReturns.fees

            formattedHistory.push({
                date: dayTimestamp,
                usdValue: currentLiquidityValue,
                fees: localFees
            })
        }
    }

    return formattedHistory
}


/**
 * @notice Example query using time travel queries
 * @dev TODO - handle scenario where blocks are not available for a timestamps (e.g. current time)
 * @param {String} pairAddress
 * @param {Array} timestamps
 */
async function getShareValueOverTime(pairAddress, timestamps) {
    if (!timestamps) {
        const utcCurrentTime = dayjs()
        const utcSevenDaysBack = utcCurrentTime.subtract(8, 'day').unix()
        timestamps = getTimestampRange(utcSevenDaysBack, 86400, 7)
    }

    // get blocks based on timestamps
    const blocks = await getBlocksFromTimestamps(timestamps)

    // get historical share values with time travel queries
    let result = await client.query({
        query: SHARE_VALUE(pairAddress, blocks),
        fetchPolicy: 'cache-first'
    })

    let values = []
    for (var row in result?.data) {
        let timestamp = row.split('t')[1]
        let sharePriceUsd = parseFloat(result.data[row]?.reserveUSD) / parseFloat(result.data[row]?.totalSupply)
        if (timestamp) {
            values.push({
                timestamp,
                sharePriceUsd,
                totalSupply: result.data[row].totalSupply,
                reserve0: result.data[row].reserve0,
                reserve1: result.data[row].reserve1,
                reserveUSD: result.data[row].reserveUSD,
                token0DerivedETH: result.data[row].token0.derivedETH,
                token1DerivedETH: result.data[row].token1.derivedETH,
                roiUsd: values && values[0] ? sharePriceUsd / values[0]['sharePriceUsd'] : 1,
                ethPrice: 0,
                token0PriceUSD: 0,
                token1PriceUSD: 0
            })
        }
    }

    // add eth prices
    let index = 0
    for (var brow in result?.data) {
        let timestamp = brow.split('b')[1]
        if (timestamp) {
            values[index].ethPrice = result.data[brow].ethPrice
            values[index].token0PriceUSD = result.data[brow].ethPrice * values[index].token0DerivedETH
            values[index].token1PriceUSD = result.data[brow].ethPrice * values[index].token1DerivedETH
            index += 1
        }
    }

    return values
}

function getTimestampRange(timestamp_from, period_length, periods) {
    let timestamps = []
    for (let i = 0; i <= periods; i++) {
        timestamps.push(timestamp_from + i * period_length)
    }
    return timestamps
}

/**
 * @notice Fetches block objects for an array of timestamps.
 * @dev blocks are returned in chronological order (ASC) regardless of input.
 * @dev blocks are returned at string representations of Int
 * @dev timestamps are returns as they were provided; not the block time.
 * @param {Array} timestamps
 */
export async function getBlocksFromTimestamps(timestamps, skipCount = 500) {
    // timestamps - hourly timestamps - not belonging to any block specifically
    if (timestamps?.length === 0) {
        return []
    }

    let fetchedData = await splitQuery(GET_BLOCKS, blockClient, [], timestamps, skipCount)

    let blocks = []
    if (fetchedData) {
        for (var t in fetchedData) {
            if (fetchedData[t].length > 0) {
                blocks.push({
                    timestamp: t.split('t')[1],
                    number: fetchedData[t][0]['number']
                })
            }
        }
    }
    return blocks
}

export async function splitQuery(query, localClient, vars, list, skipCount = 100) {
    let fetchedData = {}
    let allFound = false
    let skip = 0

    while (!allFound) {
        let end = list.length
        if (skip + skipCount < list.length) {
            end = skip + skipCount
        }
        let sliced = list.slice(skip, end)
        let result = await localClient.query({
            query: query(...vars, sliced),
            fetchPolicy: 'cache-first'
        })
        fetchedData = {
            ...fetchedData,
            ...result.data
        }
        if (Object.keys(result.data).length < skipCount || skip + skipCount > list.length) {
            allFound = true
        } else {
            skip += skipCount
        }
    }

    return fetchedData
}

const GET_BLOCKS = timestamps => {
    let queryString = 'query blocks {'
    queryString += timestamps.map(timestamp => {
        return `t${timestamp}:blocks(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_gt: ${timestamp}, timestamp_lt: ${timestamp +
        600} }) {
      number
    }`
    })
    queryString += '}'
    return queryString
}

const blockClient = new ApolloClient({
    link: new HttpLink({
        uri: 'https://api.thegraph.com/subgraphs/name/blocklytics/ethereum-blocks'
    }),
    cache: new InMemoryCache()
})

export const SHARE_VALUE = (pairAddress, blocks) => {
    let queryString = 'query blocks {'
    queryString += blocks.map(
        block => `
      t${block.timestamp}:pair(id:"${pairAddress}", block: { number: ${block.number} }) { 
        reserve0
        reserve1
        reserveUSD
        totalSupply 
        token0{
          derivedETH
        }
        token1{
          derivedETH
        }
      }
    `
    )
    queryString += ','
    queryString += blocks.map(
        block => `
      b${block.timestamp}: bundle(id:"1", block: { number: ${block.number} }) { 
        ethPrice
      }
    `
    )

    queryString += '}'
    return gql(queryString)
}

async function main() {
    const endpoint = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2'
    // The keys are lowercase on thegraph.com
    let userAddress = '0x001b71fad769b3cd47fd4c9849c704fdfabf6096'

    // TODO
}

main().catch((error) => console.error(error))
