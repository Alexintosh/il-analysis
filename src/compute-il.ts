import {request, gql} from 'graphql-request'

async function main() {
    const endpoint = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2'
    let userAddress = '0x001b71fad769b3cd47fd4c9849c704fdfabf6096'
    // The keys are lowercase on thegraph.com
    userAddress = userAddress.toLocaleLowerCase()

    const query = gql`
        {
            liquidityPositionSnapshots(where: {user: "${userAddress}"}) {
                pair {
                    token0 {
                        symbol
                    }
                    token0Price
                    token1 {
                        symbol
                    }
                    token1Price
                    reserveUSD
                    reserve0
                    reserve1
                }
                token0PriceUSD
                token1PriceUSD
            }
        }
    `

    const data = await request(endpoint, query)
    for (let snapshot of data['liquidityPositionSnapshots']) {
        let pair = snapshot['pair']
        let t0OldPrice: number = snapshot['token0PriceUSD']
        let t1OldPrice: number = snapshot['token1PriceUSD']
        let [t0NewPrice, t1NewPrice] = getDollarPrice(pair)
        let impLoss = computeImpLoss(t0OldPrice, t1OldPrice, t0NewPrice, t1NewPrice)
        console.log(`${pair['token0']['symbol']}/${pair['token1']['symbol']}`)
        console.log(`Old prices: ${t0OldPrice}, ${t1OldPrice}   Ratio: ${t0OldPrice / t1OldPrice}`)
        console.log(`New prices: ${t0NewPrice}, ${t1NewPrice}   Ratio: ${t0NewPrice / t1NewPrice}`)
        console.log(`Impermanent loss: ${impLoss}`)
        console.log(`----------------------------`)
    }
}


function getDollarPrice(pair: any): [number, number] {
    // V graph je aktuální cena uvedena jen relativně mezi tokeny
    // Já potřebuju cenu v dolarech, proto jsem jí odvodil ze soustavy:
    // r0 * t0Relativní + r1 * t1Relativní = reserveUSD
    // t1Relativní = r1/r0*t0Relativní
    // ==> t0Dolary = reserveUSD/(2*r0)
    // ==> t1Dolary = reserveUSD/(2*r1)
    const rusd: number = pair['reserveUSD']
    const r0: number = pair['reserve0']
    const r1: number = pair['reserve1']
    const t0usd = rusd / (2 * r0)
    const t1usd = rusd / (2 * r1)
    return [t0usd, t1usd]
}


/**
 * Returns impermanent loss in absolute numbers
 * (e.g. 0.8 return value means that you will lose
 * 80 % of your value compared to hodl)
 * @param t0OldPrice
 * @param t1OldPrice
 * @param t0NewPrice
 * @param t1NewPrice
 */
function computeImpLoss(t0OldPrice: number, t1OldPrice: number, t0NewPrice: number, t1NewPrice: number): number {
    const t0PriceChangeCoeff = t0NewPrice / t0OldPrice
    const t1PriceChangeCoeff = t1NewPrice / t1OldPrice
    const priceChangeRatio = t0PriceChangeCoeff / t1PriceChangeCoeff
    return Math.abs(2 * Math.sqrt(priceChangeRatio) / (1 + priceChangeRatio) - 1)
}

main().catch((error) => console.error(error))