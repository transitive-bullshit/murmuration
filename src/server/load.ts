import type { DatabaseSync } from 'node:sqlite'

import type { TweetKind } from '../shared/types'
import { parseIsoSeconds, snowflakeSeconds } from './time'

// Raw, lightly normalized records read from the Birdclaw store. All queries
// are SELECTs against a read-only connection.

export interface RawAccount {
  id: string
  handle: string
  name: string
  externalUserId: string
  profileId: string
  createdAt: number
}

export interface RawTweet {
  id: string
  kind: TweetKind
  t: number
  text: string
  authorProfileId: string | null
  replyToId: string | null
  /** profile id of the account replied to, when known */
  replyToProfileId: string | null
  quotedTweetId: string | null
  likes: number
  rts: number
  replies: number
  quotes: number
  views: number
  mediaType: 'image' | 'video' | 'gif' | null
  mediaUrl: string
  urls: string[]
  /** profile ids of mentioned accounts */
  mentions: string[]
  hashtags: number
}

export interface RawProfile {
  id: string
  handle: string
  name: string
  followers: number
  avatar: string
  verified: boolean
  createdAt: number | undefined
  externalId: string
}

export interface RawFollowMember {
  profileId: string
  externalUserId: string
  position: number
}

export interface RawFollowSnapshot {
  id: string
  direction: 'followers' | 'following'
  /** Birdclaw status: `complete`, `incomplete` (capped sync), or `partial` (archive import) */
  status: string
  completedAt: number
  members: RawFollowMember[]
}

export interface RawFollowEvent {
  profileId: string
  direction: 'followers' | 'following'
  kind: 'started' | 'ended'
  t: number
  snapshotId: string
}

export interface RawDmBucket {
  profileId: string
  direction: 'inbound' | 'outbound'
  /** quarter start, unix seconds */
  quarter: number
  count: number
}

export interface RawInbound {
  tweetId: string
  authorProfileId: string
  t: number
}

export interface RawArchive {
  account: RawAccount
  mine: RawTweet[]
  likes: RawTweet[]
  bookmarks: RawTweet[]
  profiles: Map<string, RawProfile>
  followSnapshots: RawFollowSnapshot[]
  followEvents: RawFollowEvent[]
  currentFollowers: Set<string>
  currentFollowing: Set<string>
  dmBuckets: RawDmBucket[]
  dmTotal: number
  inbound: RawInbound[]
  followerAnchors: { t: number; followers: number; following: number }[]
}

type Row = Record<string, unknown>

const str = (v: unknown) =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'bigint'
      ? String(v)
      : ''
const num = (v: unknown, fallback = -1) => {
  const n =
    typeof v === 'number'
      ? v
      : typeof v === 'string' && v !== ''
        ? Number(v)
        : NaN
  return Number.isFinite(n) ? n : fallback
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

const profileIdForUser = (externalId: string) => `profile_user_${externalId}`

function tweetTime(id: string, createdAt: unknown): number {
  return parseIsoSeconds(str(createdAt)) ?? snowflakeSeconds(id) ?? 0
}

interface Entities {
  urls?: Array<{ expandedUrl?: string; url?: string }>
  mentions?: Array<{ id?: string; username?: string }>
  hashtags?: unknown[]
}

interface MediaItem {
  type?: string
  thumbnailUrl?: string
  url?: string
}

function readMedia(
  mediaJson: unknown
): Pick<RawTweet, 'mediaType' | 'mediaUrl'> {
  const media = parseJson<MediaItem[]>(mediaJson, [])
  const first = media[0]
  if (!first) return { mediaType: null, mediaUrl: '' }
  const type =
    first.type === 'video' ? 'video' : first.type === 'gif' ? 'gif' : 'image'
  return { mediaType: type, mediaUrl: first.thumbnailUrl ?? first.url ?? '' }
}

function readEntities(
  entitiesJson: unknown,
  handleToProfile: Map<string, string>
) {
  const e = parseJson<Entities>(entitiesJson, {})
  const urls = (e.urls ?? [])
    .map((u) => u.expandedUrl ?? u.url ?? '')
    .filter(
      (u) =>
        u &&
        !/pic\.(x|twitter)\.com|\/photo\/\d|\/video\/\d|pbs\.twimg\.com/.test(u)
    )
  const mentions: string[] = []
  for (const m of e.mentions ?? []) {
    if (m.id && /^\d+$/.test(m.id)) mentions.push(profileIdForUser(m.id))
    else if (m.username) {
      const pid = handleToProfile.get(m.username.toLowerCase())
      if (pid) mentions.push(pid)
    }
  }
  return { urls, mentions, hashtags: e.hashtags?.length ?? 0 }
}

function noteText(noteJson: unknown): string | undefined {
  const note = parseJson<{ text?: string } | null>(noteJson, null)
  return note?.text || undefined
}

interface Metrics {
  likes: number
  rts: number
  replies: number
  quotes: number
  views: number
  replyToUserId?: string
}

function mergePayloadMetrics(
  acc: Metrics,
  source: string,
  payload: Row
): Metrics {
  if (source === 'twitter_archive') {
    acc.likes = Math.max(acc.likes, num(payload.favorite_count))
    acc.rts = Math.max(acc.rts, num(payload.retweet_count))
    const replyTo = str(
      payload.in_reply_to_user_id_str ?? payload.in_reply_to_user_id
    )
    if (replyTo) acc.replyToUserId = replyTo
    return acc
  }
  const pm = (payload.public_metrics ?? {}) as Row
  acc.likes = Math.max(acc.likes, num(pm.like_count))
  acc.rts = Math.max(acc.rts, num(pm.retweet_count))
  acc.replies = Math.max(acc.replies, num(pm.reply_count))
  acc.quotes = Math.max(acc.quotes, num(pm.quote_count))
  acc.views = Math.max(acc.views, num(pm.impression_count))
  const replyTo = str(payload.in_reply_to_user_id)
  if (replyTo) acc.replyToUserId = replyTo
  return acc
}

export function loadArchive(db: DatabaseSync): RawArchive {
  const accountRow = db
    .prepare(
      `select id, name, handle, external_user_id, created_at from accounts
       order by is_default desc, created_at asc limit 1`
    )
    .get() as Row | undefined
  if (!accountRow)
    throw new Error(
      'No account found in the Birdclaw store. Run `birdclaw import archive` first.'
    )

  const externalUserId = str(accountRow.external_user_id)
  const account: RawAccount = {
    id: str(accountRow.id),
    handle: str(accountRow.handle).replace(/^@/, ''),
    name: str(accountRow.name),
    externalUserId,
    profileId: profileIdForUser(externalUserId),
    createdAt: parseIsoSeconds(str(accountRow.created_at)) ?? 0
  }

  // Profiles ---------------------------------------------------------------
  const profiles = new Map<string, RawProfile>()
  const handleToProfile = new Map<string, string>()
  for (const r of db
    .prepare(
      `select id, handle, display_name, followers_count, avatar_url, verified_type,
              json_extract(raw_json, '$.created_at') as raw_created_at
       from profiles`
    )
    .all() as Row[]) {
    const id = str(r.id)
    const handle = str(r.handle)
    const isStub = /^id\d|^birdclaw_stub_|^group-|^unknown$/.test(handle)
    const externalId = id.startsWith('profile_user_')
      ? id.slice('profile_user_'.length)
      : ''
    profiles.set(id, {
      id,
      handle: isStub ? '' : handle,
      name: isStub ? '' : str(r.display_name),
      followers: num(r.followers_count, 0) > 0 ? num(r.followers_count) : -1,
      avatar: str(r.avatar_url),
      verified: !!r.verified_type,
      createdAt: parseIsoSeconds(str(r.raw_created_at)),
      externalId
    })
    if (!isStub) handleToProfile.set(handle.toLowerCase(), id)
  }

  // Authored tweets ----------------------------------------------------------
  // Metrics are merged per edit chain (keyed by root id); the surviving
  // revision's id maps back to its root so edited tweets keep their metrics.
  const metrics = new Map<string, Metrics>()
  const rootOf = new Map<string, string>()
  for (const r of db
    .prepare(
      `select r.root_tweet_id as root, r.revision_id as rev, r.source, r.payload_json
       from tweet_revisions r
       where r.payload_json is not null
         and (
           r.root_tweet_id in (select tweet_id from tweet_account_edges where account_id = ? and kind = 'authored')
           or r.revision_id in (select tweet_id from tweet_account_edges where account_id = ? and kind = 'authored')
         )`
    )
    .all(account.id, account.id) as Row[]) {
    const root = str(r.root)
    rootOf.set(str(r.rev), root)
    const payload = parseJson<Row>(r.payload_json, {})
    const acc = metrics.get(root) ?? {
      likes: -1,
      rts: -1,
      replies: -1,
      quotes: -1,
      views: -1
    }
    metrics.set(root, mergePayloadMetrics(acc, str(r.source), payload))
  }

  const mine: RawTweet[] = []
  for (const r of db
    .prepare(
      `select t.id, t.text, t.created_at, t.reply_to_id, t.like_count, t.media_json,
              t.entities_json, t.quoted_tweet_id, t.note_tweet_json,
              parent.author_profile_id as parent_author
       from tweets t
       left join tweets parent on parent.id = t.reply_to_id
       where t.deleted_at is null and t.superseded_at is null
         and exists (
           select 1 from tweet_account_edges e
           where e.tweet_id = t.id and e.account_id = ? and e.kind = 'authored'
         )`
    )
    .all(account.id) as Row[]) {
    const id = str(r.id)
    const m = metrics.get(rootOf.get(id) ?? id) ?? {
      likes: -1,
      rts: -1,
      replies: -1,
      quotes: -1,
      views: -1
    }
    const likes = Math.max(m.likes, num(r.like_count))
    const { urls, mentions, hashtags } = readEntities(
      r.entities_json,
      handleToProfile
    )
    const replyToId = str(r.reply_to_id) || null
    let replyToProfileId: string | null = null
    if (replyToId) {
      const parentAuthor = str(r.parent_author)
      if (m.replyToUserId) replyToProfileId = profileIdForUser(m.replyToUserId)
      else if (parentAuthor && parentAuthor !== 'profile_unknown')
        replyToProfileId = parentAuthor
      else replyToProfileId = mentions[0] ?? null
    }
    mine.push({
      id,
      kind: 'mine',
      t: tweetTime(id, r.created_at),
      text: noteText(r.note_tweet_json) ?? str(r.text),
      authorProfileId: account.profileId,
      replyToId,
      replyToProfileId,
      quotedTweetId: str(r.quoted_tweet_id) || null,
      likes,
      rts: m.rts,
      replies: m.replies,
      quotes: m.quotes,
      views: m.views,
      ...readMedia(r.media_json),
      urls,
      mentions,
      hashtags
    })
  }

  // Likes & bookmarks --------------------------------------------------------
  const mineIds = new Set(mine.map((t) => t.id))
  const collected = new Map<string, RawTweet>()
  for (const r of db
    .prepare(
      `select t.id, t.text, t.created_at, t.like_count, t.media_json, t.entities_json,
              t.author_profile_id, t.reply_to_id, t.quoted_tweet_id, t.note_tweet_json, c.kind
       from tweet_collections c
       join tweets t on t.id = c.tweet_id
       where c.account_id = ? and c.kind in ('likes', 'bookmarks')
         and t.deleted_at is null and t.superseded_at is null`
    )
    .all(account.id) as Row[]) {
    const id = str(r.id)
    if (mineIds.has(id)) continue
    const kind: TweetKind = str(r.kind) === 'likes' ? 'like' : 'bookmark'
    const existing = collected.get(id)
    if (existing && existing.kind === 'like') continue
    const author = str(r.author_profile_id)
    const { urls, mentions, hashtags } = readEntities(
      r.entities_json,
      handleToProfile
    )
    const likeCount = num(r.like_count)
    collected.set(id, {
      id,
      kind,
      t: tweetTime(id, r.created_at),
      text: noteText(r.note_tweet_json) ?? str(r.text),
      authorProfileId: author && author !== 'profile_unknown' ? author : null,
      replyToId: str(r.reply_to_id) || null,
      replyToProfileId: null,
      quotedTweetId: str(r.quoted_tweet_id) || null,
      likes: likeCount > 0 ? likeCount : -1,
      rts: -1,
      replies: -1,
      quotes: -1,
      views: -1,
      ...readMedia(r.media_json),
      urls,
      mentions,
      hashtags
    })
  }
  const likes = [...collected.values()].filter((t) => t.kind === 'like')
  const bookmarks = [...collected.values()].filter((t) => t.kind === 'bookmark')

  // Follow graph ---------------------------------------------------------------
  const snapshots = db
    .prepare(
      `select id, direction, completed_at, status, result_count from follow_snapshots
       where account_id = ? order by completed_at asc`
    )
    .all(account.id) as Row[]
  const memberStmt = db.prepare(
    `select profile_id, external_user_id, position from follow_snapshot_members
     where snapshot_id = ? order by position asc`
  )
  const followSnapshots: RawFollowSnapshot[] = snapshots.map((s) => ({
    id: str(s.id),
    direction: str(s.direction) === 'following' ? 'following' : 'followers',
    status: str(s.status),
    completedAt: parseIsoSeconds(str(s.completed_at)) ?? 0,
    members: (memberStmt.all(str(s.id)) as Row[]).map((m) => ({
      profileId: str(m.profile_id),
      externalUserId: str(m.external_user_id),
      position: num(m.position, 0)
    }))
  }))

  const followEvents: RawFollowEvent[] = (
    db
      .prepare(
        `select profile_id, direction, kind, event_at, snapshot_id from follow_events
         where account_id = ?`
      )
      .all(account.id) as Row[]
  ).map((e) => ({
    profileId: str(e.profile_id),
    direction: str(e.direction) === 'following' ? 'following' : 'followers',
    kind: str(e.kind) === 'ended' ? 'ended' : 'started',
    t: parseIsoSeconds(str(e.event_at)) ?? 0,
    snapshotId: str(e.snapshot_id)
  }))

  const currentFollowers = new Set<string>()
  const currentFollowing = new Set<string>()
  for (const e of db
    .prepare(
      `select direction, profile_id from follow_edges where account_id = ? and current = 1`
    )
    .all(account.id) as Row[]) {
    ;(str(e.direction) === 'following'
      ? currentFollowing
      : currentFollowers
    ).add(str(e.profile_id))
  }

  // DMs (counts only; message text never leaves SQLite) ----------------------
  const dmBuckets: RawDmBucket[] = []
  let dmTotal = 0
  for (const r of db
    .prepare(
      `select c.participant_profile_id as pid, m.direction as dir,
              strftime('%Y', m.created_at) as y,
              (cast(strftime('%m', m.created_at) as integer) - 1) / 3 as q,
              count(*) as n
       from dm_messages m
       join dm_conversations c on c.id = m.conversation_id
       where c.account_id = ? and c.participant_profile_id like 'profile_user_%'
       group by 1, 2, 3, 4`
    )
    .all(account.id) as Row[]) {
    const year = num(r.y, 0)
    if (!year) continue
    const count = num(r.n, 0)
    dmTotal += count
    dmBuckets.push({
      profileId: str(r.pid),
      direction: str(r.dir) === 'outbound' ? 'outbound' : 'inbound',
      quarter: Date.UTC(year, num(r.q, 0) * 3, 1) / 1000,
      count
    })
  }

  // Inbound replies & mentions that happen to be in the archive --------------
  const inbound: RawInbound[] = (
    db
      .prepare(
        `select t.id, t.author_profile_id, t.created_at from tweets t
         where t.author_profile_id != ? and t.author_profile_id != 'profile_unknown'
           and t.deleted_at is null
           and (
             exists (select 1 from tweet_account_edges e where e.tweet_id = t.id and e.account_id = ? and e.kind = 'mention')
             or t.reply_to_id in (select tweet_id from tweet_account_edges where account_id = ? and kind = 'authored')
           )`
      )
      .all(account.profileId, account.id, account.id) as Row[]
  ).map((r) => ({
    tweetId: str(r.id),
    authorProfileId: str(r.author_profile_id),
    t: tweetTime(str(r.id), r.created_at)
  }))

  // Exact follower counts observed by Birdclaw over time ----------------------
  const followerAnchors = (
    db
      .prepare(
        `select observed_at, followers_count, following_count from profile_snapshots
         where profile_id = ? and followers_count > 0 order by observed_at asc`
      )
      .all(account.profileId) as Row[]
  ).map((r) => ({
    t: parseIsoSeconds(str(r.observed_at)) ?? 0,
    followers: num(r.followers_count, 0),
    following: num(r.following_count, 0)
  }))

  return {
    account,
    mine,
    likes,
    bookmarks,
    profiles,
    followSnapshots,
    followEvents,
    currentFollowers,
    currentFollowing,
    dmBuckets,
    dmTotal,
    inbound,
    followerAnchors
  }
}
