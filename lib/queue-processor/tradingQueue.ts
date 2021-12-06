import { Job, Worker } from 'bullmq'
// import { omit } from 'lodash'

import { ANCILLARY_TASKS, STRATEGIES } from '../constants'
import { ancillaryQueue } from '../queue'
import console from '../logging'
import {
  addToAutoSquareOffQueue,
  addToNextQueue,
  ANCILLARY_Q_NAME,
  redisConnection,
  TRADING_Q_NAME
} from '../queue'
import atmStraddle from '../strategies/atmStraddle'
import directionalOptionSelling from '../strategies/directionalOptionSelling'
import optionBuyingStrategy from '../strategies/optionBuyingStrategy'
import strangle from '../strategies/strangle'
import { getCustomBackoffStrategies, ms } from '../utils'

async function processJob (job: Job) {
  const {
    data,
    data: { strategy }
  } = job
  console.log(`[job processing] Beginning job processing for ${strategy}`)
  switch (strategy) {
    case STRATEGIES.ATM_STRADDLE: {
      return atmStraddle(data)
    }
    case STRATEGIES.ATM_STRANGLE: {
      return strangle(data)
    }
    case STRATEGIES.DIRECTIONAL_OPTION_SELLING: {
      return directionalOptionSelling(data)
    }
    case STRATEGIES.OPTION_BUYING_STRATEGY: {
      return optionBuyingStrategy(data)
    }
    default: {
      return null
    }
  }
}

const worker = new Worker(
  TRADING_Q_NAME,
  async job => {
    // console.log(`processing tradingQueue id ${job.id}`, omit(job.data, ['user']))
    const result = await processJob(job)
    // console.log(`processed tradingQueue id ${job.id}`, result)

    try {
      // schedule a task to sync orderbook by orderTag end of day
      const { orderTag, user } = job.data
      const numberOfJobs:number=await ancillaryQueue.count()
      /*ANILTODO: 1.Check if there are any jobs in the queue 
                  2.If there are no jobs, add to queue. Else add. */
      console.log(`Jobs in ancillaryQueue=${numberOfJobs}`);
      if (numberOfJobs ===0)
      // console.log('enabling orderbook sync by tag = ', orderTag)
      // await addToNextQueue(
      //   {
      //     ancillaryTask: ANCILLARY_TASKS.ORDERBOOK_SYNC_BY_TAG,
      //     orderTag,
      //     user
      //   },
      //   {
      //     _nextTradingQueue: ANCILLARY_Q_NAME
      //   }
      // )
      await addToNextQueue(
        {
          ancillaryTask: ANCILLARY_TASKS.ORDERBOOKSYNC,
          orderTag,
          user
        },
        {
          _nextTradingQueue: ANCILLARY_Q_NAME
        }
      )
    } catch (e) {
      console.log('[error] enabling orderbook sync by tag...', e)
    }

    const { isAutoSquareOffEnabled, strategy } = job.data
    // can't enable auto square off for DOS
    // because we don't know upfront how many orders would get punched
    if (
      strategy !== STRATEGIES.DIRECTIONAL_OPTION_SELLING &&
      isAutoSquareOffEnabled
    ) {
      try {
        // console.log('enabling auto square off...')
        const asoResponse = await addToAutoSquareOffQueue({
          //eslint-disable-line
          initialJobData: job.data,
          jobResponse: result
        })
        // const { data, name } = asoResponse
        // console.log('🟢 success enable auto square off', { data, name })
      } catch (e) {
        console.log('🔴 failed to enable auto square off', e)
      }
    }
    return result
  },
  {
    connection: redisConnection,
    concurrency: 20,
    settings: {
      backoffStrategies: getCustomBackoffStrategies()
    },
    lockDuration: ms(5 * 60)
  }
)

worker.on('completed', job => {
  const { data, returnvalue } = job
  try {
    if (job.returnvalue?._nextTradingQueue) {
      addToNextQueue(data, returnvalue)
    }
  } catch (e) {
    console.log('job return value', job.returnvalue)
    console.log('failed inside trading queue worked completed event!', e)
  }
})

worker.on('error', err => {
  // log the error
  console.log('🔴 [tradingQueue] worker error', err)
})
