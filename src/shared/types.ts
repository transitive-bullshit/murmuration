// Data contract between the local analytics server and the browser client.
// Everything is columnar so the client can upload straight into GPU buffers.

export const DATASET_VERSION = 1

export type TweetKind = 'mine' | 'like' | 'bookmark'
export const TWEET_KINDS: readonly TweetKind[] = ['mine', 'like', 'bookmark']

// Bit flags describing the shape of a tweet.
export const FMT = {
  reply: 1 << 0,
  retweet: 1 << 1,
  quote: 1 << 2,
  image: 1 << 3,
  video: 1 << 4,
  link: 1 << 5,
  threadHead: 1 << 6,
  threadPart: 1 << 7,
  question: 1 << 8,
  hashtag: 1 << 9,
  mention: 1 << 10,
  selfReply: 1 << 11
} as const

// Mutually exclusive primary format for "what kind of tweet was this?".
export const FORMATS = [
  'text',
  'image',
  'video',
  'link',
  'quote',
  'thread',
  'reply',
  'retweet'
] as const
export type Format = (typeof FORMATS)[number]

export interface TweetColumns {
  n: number
  id: string[]
  /** index into TWEET_KINDS */
  kind: number[]
  /** unix seconds; for likes this is the liked tweet's post time (X exports no like timestamps) */
  t: number[]
  /** -1 when unknown */
  likes: number[]
  rts: number[]
  replies: number[]
  quotes: number[]
  views: number[]
  /** FMT bitmask */
  flags: number[]
  /** index into FORMATS */
  format: number[]
  /** visible text length, URLs stripped */
  len: number[]
  /** index into people columns, -1 when unknown */
  author: number[]
  /** semantic cluster id, -1 when unclustered */
  cluster: number[]
  /** semantic 3D coordinates, roughly in [-1, 1] */
  sx: number[]
  sy: number[]
  sz: number[]
  /** robust z-score of log engagement vs. your typical tweet at the time (mine only, else 0) */
  outlier: number[]
  /** engagement relative to your rolling median at the time (mine only, else 0) */
  lift: number[]
  text: string[]
  /** first media preview URL, '' when none */
  media: string[]
}

export interface SemanticCluster {
  id: number
  label: string
  terms: string[]
  size: number
  centroid: [number, number, number]
}

export interface WeeklySeries {
  /** bucket start times, unix seconds, 7 days apart */
  t: number[]
  /** original tweets (not replies, not retweets) */
  posts: number[]
  replies: number[]
  /** liked tweets by post time (proxy for like time) */
  likesGiven: number[]
  /** likes received on tweets posted that week */
  likesReceived: number[]
  /** retweets received on tweets posted that week */
  rtsReceived: number[]
  /** rolling median likes per original tweet (13-week centered window) */
  medianLikes: number[]
  /** rolling mean engagement (likes + 2·rts) per original tweet */
  meanEngagement: number[]
  /** reconstructed follower count at the end of the week */
  followers: number[]
  /** reconstructed followers gained during the week */
  followerGain: number[]
  /** reconstructed following count at the end of the week */
  following: number[]
}

export interface InflectionCause {
  /** index into tweet columns, or -1 for "off-platform / not explained by your tweets" */
  tweet: number
  /** share of the attributed effect, 0..1 */
  weight: number
  reason: string
}

export interface Inflection {
  id: string
  metric: 'followers' | 'engagement'
  /** a sharp one-off spike, or a sustained shift in growth rate */
  kind: 'spike' | 'surge'
  /** peak week start, unix seconds */
  t: number
  t0: number
  t1: number
  gain: number
  baseline: number
  /** robust z-score of the peak vs. its surroundings */
  z: number
  ratio: number
  summary: string
  causes: InflectionCause[]
  /** notable accounts (index into people) estimated to have followed during the window */
  notableFollowers: number[]
}

export const REL = {
  follower: 1 << 0,
  following: 1 << 1,
  dm: 1 << 2,
  interacted: 1 << 3,
  author: 1 << 4
} as const

export interface PeopleColumns {
  n: number
  id: string[]
  handle: string[]
  name: string[]
  avatar: string[]
  /** their follower count, -1 when unknown */
  followers: number[]
  verified: number[]
  /** REL bitmask */
  rel: number[]
  /** estimated unix seconds they followed you, -1 when not a follower */
  followedAt: number[]
  /** estimated unix seconds you followed them, -1 when not followed */
  followingAt: number[]
  /** your replies to them */
  outReplies: number[]
  /** your mentions of them (excluding replies) */
  outMentions: number[]
  /** your likes of their tweets (known authors only) */
  outLikes: number[]
  /** your quotes / retweets of them */
  outShares: number[]
  /** their replies and mentions to you that are in the archive */
  inMentions: number[]
  dmIn: number[]
  dmOut: number[]
  /** mutual-engagement closeness, 0..1 */
  closeness: number[]
  /** robust outlier score for this relationship (spikes, one-sided floods, notable followers) */
  outlier: number[]
  outlierReason: string[]
}

export interface PeopleTimeline {
  /** quarter start times, unix seconds */
  t: number[]
  /** indices into people for which a timeline is stored */
  people: number[]
  /** closeness per stored person per quarter, row-major people × quarters */
  closeness: number[]
}

export interface FollowerModelInfo {
  method: string
  total: number
  following: number
  blocks: number
  anchors: { t: number; followers: number }[]
}

export interface DatasetMeta {
  version: number
  generatedAt: string
  dbPath: string
  dbModifiedAt: string
  account: {
    handle: string
    name: string
    profileId: string
    createdAt: number
  }
  counts: {
    mine: number
    likes: number
    bookmarks: number
    followers: number
    following: number
    dms: number
  }
  range: { start: number; end: number }
  timings: Record<string, number>
}

export interface Dataset {
  meta: DatasetMeta
  tweets: TweetColumns
  clusters: SemanticCluster[]
  series: WeeklySeries
  inflections: Inflection[]
  people: PeopleColumns
  peopleTimeline: PeopleTimeline
  followerModel: FollowerModelInfo
}

export interface BuildProgress {
  phase: string
  fraction: number
  done: boolean
  error?: string
}
