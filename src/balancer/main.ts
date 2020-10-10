import {gql, request} from "graphql-request";

interface PoolToken {
    symbol: string;
    name: string;
    address: string;
    weight: number;
    reserve: number;
}

interface PoolItem {
    poolAddress: string;
    liqTokBalance: number;
    tokens: PoolToken[];
}

async function main() {
    // let userAddress = '0xa8eac1ec5054543ba627d0a06a96be024a6e924b'
    let userAddress = '0x1486dbe4eced88b824f48a49e6a8456a465924e4'
    console.log(await getPoolItems(userAddress))
}

async function getPoolItems(address: string): Promise<PoolItem[]> {
    const endpoint = 'https://api.thegraph.com/subgraphs/name/balancer-labs/balancer'
    // The keys are lowercase on thegraph.com
    address = address.toLocaleLowerCase()
    let includeClosedPositions = false
    let min = includeClosedPositions ? -1 : 0

    const query = gql`
        {
            poolShares(where: {userAddress: "${address}", balance_gt: ${min}}) {
                userAddress {
                    id
                }
                balance
                poolId {
                    id
                    symbol
                    totalWeight
                    liquidity
                    tokens {
                        symbol
                        name
                        address
                        denormWeight
                        balance
                    }
                }
            }
        }
    `
    const data = await request(endpoint, query)
    const pools: PoolItem[] = []
    for (let poolShare of data['poolShares']) {
        let totalWeight = Number(poolShare.poolId.totalWeight)
        let tokens: PoolToken[] = []
        for (let token of poolShare.poolId.tokens) {
            tokens.push({
                symbol: token.symbol,
                name: token.name,
                address: token.address,
                weight: Number(token.denormWeight) / totalWeight * 100,
                reserve: Number(token.balance)
            })
        }
        pools.push({
            poolAddress: poolShare.poolId.id,
            liqTokBalance: Number(poolShare.balance),
            tokens: tokens,
        })
    }
    return pools
}

main().catch((error) => console.error(error))