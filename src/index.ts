import * as dotenv from 'dotenv'
dotenv.config()

import { AppBskyGraphGetFollows, BskyAgent } from '@atproto/api'
import { ProfileView } from '@atproto/api/dist/client/types/app/bsky/actor/defs';
import sqlite3 from "sqlite3";
import { Database, open } from 'sqlite'

// hubs plus a couple other seed accounts
const HUBS = new Set([
    "euxenus.bsky.social",
    "eigenrobot.bsky.social",
    "tho.bsky.social",
    "miranda.bsky.social",
    "ryanhoulihan.bsky.social"
]);

const SQLITE_DB_FILE = "test.sqlite";
const RETRY_LIMIT = 5;
// const SLEEP_TIME = 1 * 1000;
const SLEEP_TIME = 50;
const FOLLOW_PAGE_LIMIT = 100;
const TWO_DAYS_IN_MS = 2 * 24 * 60 * 60 * 1000;

type DB = Database<sqlite3.Database, sqlite3.Statement>

/*

Start from the hub nodes, grab all their out edges

along the way store their profile info

    Profiles look like:
    subject: {
      did: 'did:plc:cm4bwax4evxmkiuwxvvkvlmx',
      handle: 'tho.bsky.social',
      displayName: 'Thomas Pockrandt',
      description: 'Tech Advisor & Digital Strategist 🦾\n\nhttps://thomaspockrandt.com',
      avatar: 'https://cdn.bsky.social/imgproxy/vNz-qGDXF4UYmenhveAPxPDSXBMRgvfoQK3XWrds-18/rs:fill:1000:1000:1:0/plain/bafkreidvjlqht65wd64dae5etrgh2xodgubeyoryxu7nugmcdzwv2qk4jq@jpeg',
      indexedAt: '2023-04-03T10:39:44.106Z',
      viewer: [Object]
    },

Follows look like:
  {
    did: 'did:plc:foqdywqos2i65u7rs5fjgfx2',
    handle: 'nonsequitrd.bsky.social',
    viewer: { muted: false }
  },

*/

// Fetch paginated data with retry handling
async function fetchWithRetry<T>(fetchFunction: () => Promise<T>) {
    let retries = 0;

    while (retries < RETRY_LIMIT) {
        try {
            return await fetchFunction();
        } catch (error: any) {
            if (error.response && error.response.status === 429) {
                // Handle rate limit
                const retryAfter = parseInt(error.response.headers["retry-after"], 10) || 60;
                await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
            } else {
                retries++;
                if (retries >= RETRY_LIMIT) {
                    console.error("Request failed after multiple retries:", error);
                    break;
                }
            }
        }
    }
}

// Function to fetch paginated data
async function fetchData(agent: BskyAgent, actor: string, cursor?: string) {
    const response: AppBskyGraphGetFollows.Response = await agent.getFollows({ "actor": actor, "cursor": cursor, "limit": FOLLOW_PAGE_LIMIT })
    return response.data;
}

async function insertIntoDB(db: DB, profile: ProfileView, following: ProfileView[]) {
    const currentDate = new Date().toISOString();

    await db.run("INSERT OR REPLACE INTO subject VALUES (?, ?, ?, ?, ?, ?, ?)", profile.did, profile.handle, profile.displayName, profile.description, profile.avatar, profile.indexedAt, currentDate);

    await db.run("INSERT OR REPLACE INTO follow_edges VALUES (?, ?, ?)", profile.did, JSON.stringify(following.map(f => f.did)), currentDate);
}

class UniqueQueue<T> {
    private set: Set<T>;
    private queue: Array<T>;

    constructor() {
        this.set = new Set<T>();
        this.queue = [];
    }

    static fromIterable<T>(list: Iterable<T>): UniqueQueue<T> {
        const uniqueQueue = new UniqueQueue<T>();
        for (const item of list) {
            uniqueQueue.enqueue(item);
        }
        return uniqueQueue;
    }

    enqueue(value: T): void {
        if (!this.set.has(value)) {
            this.set.add(value);
            this.queue.push(value);
        }
    }

    dequeue(): T | null {
        if (this.queue.length === 0) {
            return null;
        }
        const dequeuedValue = this.queue.shift() as T;
        this.set.delete(dequeuedValue);
        return dequeuedValue;
    }

    size(): number {
        return this.queue.length;
    }
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const test = async () => {
    // Initialize SQLite database
    const db = await open({
        filename: SQLITE_DB_FILE,
        driver: sqlite3.Database
    })

    // Create the table
    db.run("CREATE TABLE IF NOT EXISTS follow_edges (did TEXT PRIMARY KEY, data TEXT, date_updated TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS subject (did TEXT PRIMARY KEY, handle TEXT, display_name TEXT, description TEXT, avatar TEXT, indexed_at TEXT, date_updated TEXT)");

    const agent = new BskyAgent({ service: 'https://bsky.social' });
    const response = await agent.login({ identifier: process.env.BSKY_EMAIL!, password: process.env.BSKY_PASSWORD! });

    const toCrawl = UniqueQueue.fromIterable(HUBS);

    while (toCrawl.size() > 0) {
        const crawlNext = toCrawl.dequeue();

        // always crawl hubs for bootstrapping
        if (!HUBS.has(crawlNext!)) {
            // check if we've already crawled this one
            const result = await db.get('SELECT date_updated FROM subject WHERE handle = ?', crawlNext);

            if (result !== undefined) {
                const lastIndexed = new Date(result.date_updated);
                const now = new Date();

                const timeDiff = now.getTime() - lastIndexed.getTime()

                // if it's been more than 2 days since it was updated, proceed
                if (timeDiff < TWO_DAYS_IN_MS) {
                    console.log(`Skipping ${crawlNext} because it was updated recently`)
                    continue;
                }
                else {
                    console.log(`Not skipping ${crawlNext} because it was updated ${timeDiff} ms ago`)
                }
            }

        }

        console.log(`Crawling following for ${crawlNext}...`)

        const allFollowEdges = [];
        let cursor: string | undefined = undefined;
        let profile: ProfileView | undefined = undefined;

        try {
            let page = 1;
            while (true) {
                const followData = await fetchWithRetry(() => fetchData(agent, crawlNext!, cursor));

                if (followData === undefined) {
                    throw Error("No data returned from fetch")
                }

                console.log(`Got ${followData.follows.length} follows for ${crawlNext} on page ${page} (cursor: ${followData.cursor})`)

                allFollowEdges.push(...followData.follows);
                profile = followData.subject;

                // not sure why it gives us a cursor when there's no more data, but it does
                // so let's stop earlier than that
                if ((followData.cursor === undefined) || (followData.follows.length < FOLLOW_PAGE_LIMIT)) {
                    break;
                }

                if (followData.cursor === cursor) {
                    // throw Error("Cursor didn't change, but we didn't get all the data. Something is wrong")
                    console.log(`Cursor didn't change, but we didn't get all the data. Something is wrong. Breaking out of loop`)
                    break;
                }

                cursor = followData.cursor;
                page++;
            }

            for (const { handle } of allFollowEdges) {
                toCrawl.enqueue(handle);
            }

            await insertIntoDB(db, profile!, allFollowEdges);
        }
        catch (error: any) {
            console.error(`Error fetching data for ${crawlNext}: ${error}. Just going to skip them`)
        }

        await sleep(SLEEP_TIME);
    }
}

test();