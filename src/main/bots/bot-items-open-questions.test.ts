import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import {
  BOT_ITEM_EVENT_KINDS,
  botItemEventId,
  parseBotItemEventId,
  type BotItemEvent
} from '../../shared/bots/bot-items'
import { botItemActivity } from '../../shared/bots/bot-item-activity'
import { botItemQuestionView } from '../../shared/bots/bot-item-ask'
import {
  botItemQuestionPairing,
  botItemWaitingAsk,
  botItemWaitingLine
} from '../../shared/bots/bot-item-question-answers'
import { waitingAskChange } from './bot-item-waiting-ask-keep'
import { botItemChangeMail } from './bot-items-mail-text'
import type { BotItemBotActor, BotItemOwnerActor } from './bot-items-input'
import { BotItemsStore } from './bot-items-store'

const NOW = 1_800_000_000_000
const AGENT: BotItemBotActor = { kind: 'bot', botId: 'agent', chatId: 'chat' }
const OWNER: BotItemOwnerActor = { kind: 'owner' }
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const MERGE = 'Merge it?'

const stores: BotItemsStore[] = []
// Second connections a test opens on its store's file, closed even when an assertion fails.
const files: DatabaseSync[] = []
afterEach(() => stores.splice(0).forEach((store) => store.dispose()))

function item(path = ':memory:') {
  const store = BotItemsStore.open(path)
  stores.push(store)
  const { uid } = store.add(
    {
      ownerBotId: AGENT.botId,
      chatId: AGENT.chatId,
      source: { kind: 'home', title: null },
      title: 'Ship it',
      status: 'working',
      links: []
    },
    AGENT,
    NOW
  )
  const ask = (questions: string[]): number => {
    const options = [{ label: 'Yes' }, { label: 'No' }]
    const asked = { questions: questions.map((prompt) => ({ prompt, options })) }
    store.set(uid, { status: 'needs_you', ask: asked }, AGENT, NOW)
    return store.get(uid)!.questionEvent!
  }
  const comment = (text: string, questionEventId?: number, skipped?: number[]) =>
    store.ownerComment(uid, text, OWNER, [], NOW, undefined, questionEventId, false, [], skipped)
  // The item as the host's read gives it now: its question with its lines, and the ask waiting.
  const hostItem = () => {
    const row = store.get(uid)!
    const waitingAsk = store.viewRows([uid], true).waitingAsks[uid]
    return {
      status: row.status,
      question:
        row.questionEvent === null
          ? null
          : botItemQuestionView(
              botItemEventId(row.questionEvent),
              store.events(uid, row.questionEvent - 1, 1)[0]!.data
            ),
      links: [],
      ...(waitingAsk ? { waitingAsk } : {})
    }
  }
  // What the item's view reads, from the host's item and the events loaded after `after`: the line
  // its comment box replies to, each ask's answers, which ask each reply quotes, and the comments
  // shown waiting. `upTo`: the last event the view has read (an Activity page read before later
  // events); `shown`: the item as an earlier read gave it (a read whose Activity came after it).
  const view = (after = 0, upTo = Number.POSITIVE_INFINITY, shown = hostItem()) => {
    const events = store
      .events(uid, after, 200)
      .filter(({ id }) => id <= upTo)
      .map(({ id, kind, actor, data, createdAt }): BotItemEvent => ({
        id: botItemEventId(id),
        kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
        actor,
        data,
        at: createdAt
      }))
    const pairing = botItemQuestionPairing(shown, events)
    return {
      replyingTo: botItemWaitingLine(shown, events),
      waitingAsk: botItemWaitingAsk(shown, events)?.askId ?? null,
      asks: pairing.questions,
      quotes: pairing.replies,
      waitingComments: botItemActivity(shown, events).flatMap((entry) =>
        entry.kind === 'comment' && entry.waiting ? [entry.event.id] : []
      )
    }
  }
  const lastComment = () =>
    store.events(uid, 0, 200).findLast((event) => event.kind === 'commented')!
  // The comment box's send of typed words, as it goes out: naming the question its "Replying to"
  // names; with none named, a comment that names no question and isn't sent as plain.
  const boxSend = (text: string, replyingTo: { eventId: string } | null) => {
    const questionId = replyingTo ? parseBotItemEventId(replyingTo.eventId)! : undefined
    store.ownerComment(uid, text, OWNER, [], NOW, undefined, questionId, false)
    return { questionId: replyingTo?.eventId, answers: lastComment().data.answers }
  }
  return { store, uid, ask, comment, view, lastComment, hostItem, boxSend }
}

it('offers no reply target for a Needs you comment that asks nothing after the questions were answered', () => {
  const { store, uid, ask, comment, view } = item()
  const asked = ask([HOSTS, GO])
  // The held answers post together.
  comment(`${HOSTS} → Yes\n${GO} → No`, asked)
  expect(store.get(uid)?.status).toBe('working')
  store.set(
    uid,
    { status: 'needs_you', comment: 'Got it. Only the hostname question is left.' },
    AGENT,
    NOW
  )
  expect(view().replyingTo).toBeNull()
})

it('replaces an earlier set of questions when a later set is asked', () => {
  const { store, uid, ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  // Answered before the later set: it stands.
  comment(`${HOSTS} → Yes`, first)
  const second = ask([MERGE])
  const { asks, replyingTo, waitingComments } = view()
  expect(asks.get(botItemEventId(first))).toMatchObject({ waiting: false, ended: 'replaced' })
  expect(asks.get(botItemEventId(first))?.answers.map(Boolean)).toEqual([true, false])
  expect(asks.get(botItemEventId(second))).toMatchObject({ waiting: true, ended: null })
  expect(replyingTo).toMatchObject({ eventId: botItemEventId(second), line: MERGE })
  expect(waitingComments).toEqual([botItemEventId(second)])
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(second))
  // A reply to the replaced set is refused.
  expect(() => comment(`${GO} → No`, first)).toThrow(/new question/)
  // Words that name no question go to the later set.
  comment('Yes')
  expect(view().asks.get(botItemEventId(first))?.answers.map(Boolean)).toEqual([true, false])
  expect(view().asks.get(botItemEventId(second))?.answers.every(Boolean)).toBe(true)
})

it('never replies to a replaced ask while the Activity read predates the ask that replaced it', () => {
  const { store, uid, ask, comment, view } = item()
  const first = ask(['Merge PR #22?', GO])
  // The desktop's Activity was read here; the agent then asks again before the owner answers.
  const readUpTo = store.events(uid, 0, 200).at(-1)!.id
  const second = ask(['Merge PR #22 and #23?'])
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(second))
  const { replyingTo, waitingAsk, asks, waitingComments } = view(0, readUpTo)
  // The host names the later ask: the earlier one, the latest the stale page holds, is no target;
  // the item's own question stands in for the later one until its event is read.
  expect(replyingTo).toMatchObject({
    eventId: botItemEventId(second),
    line: 'Merge PR #22 and #23?'
  })
  expect(waitingAsk).toBeNull()
  expect(asks.get(botItemEventId(first))).toMatchObject({ waiting: false })
  expect(waitingComments).not.toContain(botItemEventId(first))
  // The host refuses a reply naming it.
  expect(() => comment('Merge PR #22? → Yes', first)).toThrow(/new question/)
  // Once the later ask is read, the box replies to it.
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(second) })
})

it('replies to the later ask when the item was read before an Activity that holds it', () => {
  const { store, uid, ask, view, hostItem, boxSend } = item()
  const first = ask(['Merge PR #22?'])
  // One read: the item first, naming the earlier ask, then its Activity, after the agent asked again.
  const readFirst = hostItem()
  expect(readFirst.waitingAsk).toBe(botItemEventId(first))
  const second = ask(['Merge PR #22 and #23?'])
  for (const after of [0, first]) {
    // The whole Activity, or a page past the earlier ask.
    const { replyingTo, waitingAsk, asks, waitingComments } = view(after, undefined, readFirst)
    expect(replyingTo).toMatchObject({
      eventId: botItemEventId(second),
      line: 'Merge PR #22 and #23?'
    })
    expect(waitingAsk).toBe(botItemEventId(second))
    expect(asks.get(botItemEventId(second))).toMatchObject({ waiting: true })
    expect(waitingComments).toEqual([botItemEventId(second)])
  }
  // The box's send names the later ask, and the host takes it as that ask's answer.
  const { replyingTo } = view(0, undefined, readFirst)
  expect(boxSend('Yes, both', replyingTo)).toEqual({
    questionId: botItemEventId(second),
    answers: botItemEventId(second)
  })
  expect(store.get(uid)?.status).toBe('working')
})

it('names the later ask on a send while the Activity read predates it', () => {
  const { store, uid, ask, view, boxSend } = item()
  ask(['Merge PR #22?'])
  const readUpTo = store.events(uid, 0, 200).at(-1)!.id
  const second = ask(['Merge PR #22 and #23?'])
  const { replyingTo } = view(0, readUpTo)
  expect(boxSend('Yes, both', replyingTo)).toEqual({
    questionId: botItemEventId(second),
    answers: botItemEventId(second)
  })
  expect(store.get(uid)?.status).toBe('working')
})

it('keeps a reply naming a replaced set off the later set, even with that set on an earlier page', () => {
  const { store, uid, ask } = item()
  const first = ask([HOSTS, GO])
  const second = ask([MERGE])
  // An older host's recorded answer to the first set, read with only the events after it loaded.
  const loaded: BotItemEvent[] = store
    .events(uid, first, 200)
    .map(({ id, kind, actor, data, createdAt }) => ({
      id: botItemEventId(id),
      kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
      actor,
      data,
      at: createdAt
    }))
  loaded.push({
    id: botItemEventId(1_000_000),
    kind: 'commented',
    actor: OWNER,
    data: { text: 'Yes', answers: botItemEventId(first), decisions: [{ pick: 0 }] },
    at: NOW
  })
  const entry = botItemQuestionPairing({ status: 'needs_you' }, loaded).questions.get(
    botItemEventId(second)
  )
  expect(entry).toMatchObject({ waiting: true })
  expect(entry?.answers.map(Boolean)).toEqual([false])
})

it('closes the questions an answer skips, so the set is finished and its mail names them', () => {
  const { store, uid, ask, comment, view, lastComment } = item()
  const asked = ask([HOSTS, GO, MERGE])
  // "send anyway" with only the first answered.
  // A line the answer names is never recorded as skipped.
  comment(`${HOSTS} → Yes`, asked, [0, 1, 2])
  expect(lastComment().data.skipped).toEqual([GO, MERGE])
  expect(store.get(uid)?.status).toBe('working')
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
  const entry = view().asks.get(botItemEventId(asked))
  expect(entry).toMatchObject({ waiting: false, ended: 'skipped' })
  expect(entry?.answers.map(Boolean)).toEqual([true, false, false])
  expect(view().replyingTo).toBeNull()
  const mail = botItemChangeMail([{ event: lastComment(), item: store.get(uid)! }])
  expect(mail?.body).toContain(
    `[Orca: they skipped the rest of that set, so these questions are closed unanswered: "${GO}", "${MERGE}". If one still matters, ask it again in a new set.]`
  )
  // A later comment answers none of them.
  comment('Yes')
  expect(view().asks.get(botItemEventId(asked))?.answers.map(Boolean)).toEqual([true, false, false])
})

it('never skips a line an earlier comment or the answer itself answered', () => {
  const { ask, comment, lastComment, store, uid } = item()
  const asked = ask([HOSTS, GO, MERGE])
  // Another device answered the second line first; this one's "send anyway" still lists it.
  comment(`${GO} → No`, asked)
  // Words that name no line answer the first open one by order.
  comment('Yes', asked, [0, 1, 2])
  expect(lastComment().data.skipped).toEqual([MERGE])
  const mail = botItemChangeMail([{ event: lastComment(), item: store.get(uid)! }])
  expect(mail?.body).toContain(
    `so this question is closed unanswered: "${MERGE}". If it still matters, ask it again in a new set.]`
  )
  // Every line answered: nothing is skipped.
  const second = ask([HOSTS, GO])
  comment(`${HOSTS} → Yes`, second)
  comment(`${GO} → No`, second, [0, 1])
  expect(lastComment().data.skipped).toBeUndefined()
})

// Send anyway reads only the events from its ask on, plus earlier asks: their lines still decide it.
it('skips the same lines when a comment answers an earlier set after a later one was asked', () => {
  const { ask, comment, lastComment } = item()
  ask([HOSTS])
  const second = ask([GO, MERGE])
  // Answers the earlier set's line, so it takes none of the later set's lines by order.
  comment(`${HOSTS} → Yes`)
  comment(`${MERGE} → Yes`, second, [0, 1])
  expect(lastComment().data.skipped).toEqual([GO])
})

it('holds the latest set until every question in it is answered', () => {
  const { store, uid, ask, comment, view } = item()
  ask([MERGE])
  const second = ask([HOSTS, GO])
  comment(`${HOSTS} → Yes`, second)
  expect(view().replyingTo).toMatchObject({ eventId: botItemEventId(second), line: GO })
  comment(`${GO} → No`, second)
  expect(view().replyingTo).toBeNull()
  expect(view().asks.get(botItemEventId(second))?.answers.every(Boolean)).toBe(true)
  expect(store.get(uid)?.status).toBe('working')
})

it('never replies to a replaced question after a Needs you comment that asks nothing', () => {
  const { store, uid, ask, comment, view } = item()
  const first = ask([HOSTS, GO])
  comment(`${HOSTS} → Yes`, first)
  const second = ask([MERGE])
  comment('Yes', second)
  store.set(uid, { status: 'needs_you', comment: 'Only one question is left.' }, AGENT, NOW)
  expect(view().replyingTo).toBeNull()
  expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
})

it('ends the open set when the item is moved by hand', () => {
  const { store, uid, ask, comment, view } = item()
  const asked = ask([HOSTS, GO])
  comment(`${HOSTS} → Yes`, asked)
  expect(view().replyingTo?.line).toBe(GO)
  store.ownerStatus({ uids: [uid], to: 'planned' }, OWNER, NOW)
  expect(view().replyingTo).toBeNull()
})

it('works out the waiting ask from the events when none is kept or an older Orca wrote after it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-items-'))
  try {
    const path = join(dir, 'items.sqlite')
    const { store, uid, ask, comment } = item(path)
    const first = ask([HOSTS, GO])
    comment(`${HOSTS} → Yes`, first)
    const second = ask([MERGE])
    const kept = store.viewRows([uid], true).waitingAsks[uid]
    expect(kept).toBe(botItemEventId(second))
    const file = new DatabaseSync(path)
    files.push(file)
    file.prepare('DELETE FROM item_waiting_asks').run()
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(kept)
    expect(file.prepare('SELECT ask FROM item_waiting_asks').get()).toEqual({ ask: second })
    // Kept by other pairing rules (another build): not trusted, even when no event came since.
    file.prepare("UPDATE item_waiting_asks SET ask = 0, rules = 'another build'").run()
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(kept)
    // An older Orca's move by hand, which ends every ask, knows nothing of the kept one.
    const moved = file
      .prepare(
        `INSERT INTO item_events (item_uid, kind, actor, data, mail, action, created_at)
         VALUES (?, 'status', '{"kind":"owner"}', '{"from":"needs_you","to":"working"}', NULL, 0, ?)`
      )
      .run(uid, NOW)
    file.prepare('UPDATE items SET last_event_id = ?').run(moved.lastInsertRowid)
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
  } finally {
    files.splice(0).forEach((file) => file.close())
    stores.splice(0).forEach((store) => store.dispose())
    rmSync(dir, { recursive: true, force: true })
  }
})

it('answers as pairing every event does, reading only the events since the kept ask when they ask nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bot-items-'))
  try {
    const path = join(dir, 'items.sqlite')
    const { store, uid, ask, comment } = item(path)
    const file = new DatabaseSync(path)
    files.push(file)
    const keptAt = (): unknown => file.prepare('SELECT at FROM item_waiting_asks').get()?.at
    const lastEvent = (): unknown =>
      file.prepare('SELECT last_event_id FROM items').get()?.last_event_id
    // What an open answers, then what pairing every event answers once nothing is kept.
    const opened = (): [string | undefined, string | undefined] => {
      const kept = store.viewRows([uid], true).waitingAsks[uid]
      file.prepare('DELETE FROM item_waiting_asks').run()
      return [kept, store.viewRows([uid], true).waitingAsks[uid]]
    }
    expect(opened()).toEqual([undefined, undefined])
    const before = keptAt()
    store.comment(uid, 'Still building.', AGENT, [], NOW)
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBeUndefined()
    expect(keptAt()).toBe(before)
    expect(opened()).toEqual([undefined, undefined])
    const asked = ask([MERGE])
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(asked))
    expect(keptAt()).toBe(lastEvent())
    expect(opened()).toEqual([botItemEventId(asked), botItemEventId(asked)])
    const waiting = keptAt()
    store.comment(uid, 'Waiting on you.', AGENT, [], NOW)
    expect(store.viewRows([uid], true).waitingAsks[uid]).toBe(botItemEventId(asked))
    expect(keptAt()).toBe(waiting)
    expect(opened()).toEqual([botItemEventId(asked), botItemEventId(asked)])
    comment('Yes', asked)
    expect(opened()).toEqual([undefined, undefined])
  } finally {
    files.splice(0).forEach((file) => file.close())
    stores.splice(0).forEach((store) => store.dispose())
    rmSync(dir, { recursive: true, force: true })
  }
})

it('passes over only events that pair nothing, and keeps "none" only past events that cannot ask', () => {
  const { store, uid, ask, comment } = item()
  const views = (): BotItemEvent[] =>
    store.events(uid, 0, 200).map(({ id, kind, actor, data, createdAt }) => ({
      id: botItemEventId(id),
      kind: BOT_ITEM_EVENT_KINDS.find((known) => known === kind) ?? 'edited',
      actor,
      data,
      at: createdAt
    }))
  const waitingOf = (events: readonly BotItemEvent[]): string | undefined =>
    [...botItemQuestionPairing({ status: 'working' }, events).questions].find(
      ([, entry]) => entry.waiting
    )?.[0]
  const event = (
    kind: BotItemEvent['kind'],
    actor: BotItemEvent['actor'],
    data: Record<string, unknown>
  ): BotItemEvent => ({ id: botItemEventId(1_000_000), kind, actor, data, at: NOW })
  const first = ask([HOSTS, GO])
  comment(`${HOSTS} → Yes`, first)
  const second = ask([MERGE])
  const waiting = views()
  expect(waitingOf(waiting)).toBe(botItemEventId(second))
  const ignored = [
    ...BOT_ITEM_EVENT_KINDS.filter((kind) => kind !== 'commented' && kind !== 'status').map(
      (kind) => event(kind, AGENT, {})
    ),
    event('commented', AGENT, { text: 'Still building.' }),
    event('status', AGENT, { from: 'working', to: 'needs_you' })
  ]
  for (const passed of ignored) {
    expect(waitingAskChange(passed.kind, passed.actor, passed.data)).toBeNull()
    expect(waitingOf([...waiting, passed])).toBe(waitingOf(waiting))
  }
  store.set(uid, { status: 'working' }, AGENT, NOW)
  const none = views()
  expect(waitingOf(none)).toBeUndefined()
  const answering = [
    event('commented', OWNER, { text: 'Yes' }),
    event('status', OWNER, { from: 'working', to: 'done' }),
    event('status', AGENT, { from: 'needs_you', to: 'working', cause: 'answer' })
  ]
  for (const passed of answering) {
    expect(waitingAskChange(passed.kind, passed.actor, passed.data)).toBe('answers')
    expect(waitingOf([...none, passed])).toBeUndefined()
  }
})
