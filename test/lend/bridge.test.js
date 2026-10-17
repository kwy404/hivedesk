import { describe, expect, it } from 'vitest';
import { LendPeer } from '../../ui/lend/core/session.js';
import { HostBridge, LenderBridge } from '../../ui/lend/core/bridge.js';
import { FakeHive, linkPair, tick, until } from './helpers.js';

function setup({ chat, rate, confirm = true } = {}) {
  const [hostLink, friendLink] = linkPair();
  const hostPeer = new LendPeer(hostLink);
  const friendPeer = new LendPeer(friendLink);
  const brainChat = [];
  const cancels = [];
  const friendHive = new FakeHive({
    'lend.chat': async (data) => {
      brainChat.push(data);
      return chat ? chat(data) : { text: `echo: ${data.messages.at(-1).content}`, promptTokens: 5, completionTokens: 3, ms: 12, model: 'fake' };
    },
    'lend.log': () => ({}),
    'lend.cancel': (data) => { cancels.push(data.requestId); return { cancelled: true }; },
  });
  const hostHive = new FakeHive({
    'brain.attach': () => ({ brainId: 'b_remote_1' }),
    'brain.respond': () => ({}),
    'brain.detach': () => ({}),
  });
  const lender = new LenderBridge({ hive: friendHive, peer: friendPeer, info: { label: 'Ana', model: 'qwen-3b' }, rate });
  const host = new HostBridge({ hive: hostHive, peer: hostPeer, label: 'Bo' });
  if (confirm) {
    hostPeer.confirmLocal();
    friendPeer.confirmLocal();
  }
  return { hostPeer, friendPeer, hostHive, friendHive, lender, host, brainChat, cancels };
}

const request = (hive, requestId, content = 'hello', options = {}) => hive.emit('brain.request', { kind: 'brain.request', brainId: 'b_remote_1', requestId, messages: [{ role: 'user', content }], options });

describe('lend bridges', () => {
  it('attaches the friend as a remote brain after both confirmations and answers a turn', async () => {
    const s = setup();
    await until(() => s.host.brainId);
    expect(s.hostHive.callsOf('brain.attach')[0]).toEqual({ label: 'Ana (lent PC)', model: 'qwen-3b', ctx: undefined });
    request(s.hostHive, 'r_1', 'write a haiku', { maxTokens: 50, signal: 'x' });
    const res = await until(() => s.hostHive.callsOf('brain.respond')[0]);
    expect(res).toEqual({ requestId: 'r_1', ok: true, result: { text: 'echo: write a haiku', promptTokens: 5, completionTokens: 3, ms: 12, model: 'fake' } });
    expect(s.brainChat[0]).toEqual({ messages: [{ role: 'user', content: 'write a haiku' }], options: { maxTokens: 50 }, requestId: 'r_1' });
    const done = s.lender.log.find((e) => e.status === 'done');
    expect(done).toMatchObject({ id: 'r_1', messages: 1, chars: 13, completionTokens: 3 });
  });

  it('ignores requests for other brains', async () => {
    const s = setup();
    await until(() => s.host.brainId);
    s.hostHive.emit('brain.request', { brainId: 'b_local', requestId: 'r_x', messages: [{ role: 'user', content: 'x' }] });
    await tick(20);
    expect(s.brainChat).toHaveLength(0);
  });

  it('sends nothing to the brain before the confirmation words are checked', async () => {
    const s = setup({ confirm: false });
    await tick(10);
    expect(s.host.brainId).toBeNull();
    s.hostPeer.link.send(JSON.stringify({ t: 'req', id: 'r_1', messages: [{ role: 'user', content: 'sneaky' }], options: {} }));
    await tick(10);
    expect(s.brainChat).toHaveLength(0);
    expect(s.hostHive.callsOf('brain.attach')).toHaveLength(0);
    s.hostPeer.confirmLocal();
    await tick(10);
    expect(s.host.brainId).toBeNull();
    s.friendPeer.confirmLocal();
    await until(() => s.host.brainId);
  });

  it('refuses a prompt above the size cap on the host, without sending it', async () => {
    const s = setup();
    await until(() => s.host.brainId);
    request(s.hostHive, 'r_big', 'a'.repeat(200000));
    const res = await until(() => s.hostHive.callsOf('brain.respond')[0]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/limit/);
    expect(s.brainChat).toHaveLength(0);
  });

  it('rate limits on the friend side', async () => {
    const s = setup({ rate: { perMinute: 2, charsPerMinute: 100000 } });
    await until(() => s.host.brainId);
    for (const id of ['r_1', 'r_2', 'r_3']) {
      request(s.hostHive, id);
      await until(() => s.hostHive.callsOf('brain.respond').some((r) => r.requestId === id));
    }
    const third = s.hostHive.callsOf('brain.respond').find((r) => r.requestId === 'r_3');
    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/^rate_limited/);
    expect(s.brainChat).toHaveLength(2);
  });

  it('runs one request at a time', async () => {
    let release;
    const s = setup({ chat: () => new Promise((r) => (release = () => r({ text: 'ok' }))) });
    await until(() => s.host.brainId);
    request(s.hostHive, 'r_1');
    await until(() => release);
    request(s.hostHive, 'r_2');
    const busy = await until(() => s.hostHive.callsOf('brain.respond').find((r) => r.requestId === 'r_2'));
    expect(busy.error).toMatch(/^busy/);
    release();
    await until(() => s.hostHive.callsOf('brain.respond').find((r) => r.requestId === 'r_1'));
  });

  it('stops lending: the host detaches the brain and pending turns fail', async () => {
    const s = setup({ chat: () => new Promise(() => {}) });
    await until(() => s.host.brainId);
    request(s.hostHive, 'r_1');
    await until(() => s.brainChat.length);
    s.lender.stop();
    await until(() => s.hostHive.callsOf('brain.detach').length);
    expect(s.hostHive.callsOf('brain.respond')).toContainEqual({ requestId: 'r_1', ok: false, error: 'The friend stopped lending' });
    expect(s.lender.lending).toBe(false);
    expect(s.lender.log.at(-1).status).toBe('stopped');
  });

  it('forwards streamed tokens and cancels', async () => {
    const s = setup({ chat: () => new Promise(() => {}) });
    await until(() => s.host.brainId);
    request(s.hostHive, 'r_1');
    await until(() => s.brainChat.length);
    s.friendPeer.send({ t: 'tok', id: 'r_1', text: 'par' });
    await until(() => s.hostHive.notes.length);
    expect(s.hostHive.notes[0]).toEqual({ type: 'brain.token', data: { requestId: 'r_1', text: 'par' } });
    s.hostHive.emit('brain.cancel', { brainId: 'b_remote_1', requestId: 'r_1' });
    await until(() => s.lender.busy?.cancelled);
    // The cancel reaches the friend's engine, which aborts the running turn (not only a flag).
    await until(() => s.cancels.length);
    expect(s.cancels).toEqual(['r_1']);
  });
});
