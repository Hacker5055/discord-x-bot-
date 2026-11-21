import { setTimeout as wait } from 'node:timers/promises';
import { isSnowflake } from '../lib/catalog.js';
import { DiscordApiError } from '../lib/errors.js';

const BASE_URL = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/Hacker5055/discord-x-bot-, 1.0.0)';

// Never pass a webhook credential from Discord into the command/reporting layer.
const webhookMetadata = ({ id, name, type, channel_id }) => ({ id, name, type, channel_id });

function retryDelay(response, body, fallback) {
  for (const seconds of [body?.retry_after, response.headers.get('retry-after'), response.headers.get('x-ratelimit-reset-after')]) {
    const ms = Number(seconds) * 1000;
    if (seconds != null && seconds !== '' && Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
  }
  const retryAt = Date.parse(response.headers.get('retry-after') ?? '');
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : fallback;
}

export class DiscordApi {
  #token;
  #fetch;
  #sleep;
  #timeoutMs;
  #now;
  #globalRetryAt = 0;

  constructor({ token, fetchImpl = fetch, sleep = wait, timeoutMs = 10_000, now = () => performance.now() }) {
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#sleep = sleep;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  async #pause(ms) {
    // Node's timers wrap oversized delays to 1 ms.
    while (ms > 2_147_483_647) {
      await this.#sleep(2_147_483_647);
      ms -= 2_147_483_647;
    }
    await this.#sleep(ms);
  }

  async #request(method, path, body, recover, { reason, guarded } = {}) {
    const headers = { authorization: `Bot ${this.#token}`, 'user-agent': USER_AGENT };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (reason) headers['x-audit-log-reason'] = encodeURIComponent(reason);

    for (let attempt = 0; ; attempt += 1) {
      // A guarded write was authorized from a fresh observation. Do not delay or
      // replay it behind a rate limit; its caller can observe again before retrying.
      if (guarded && this.#globalRetryAt > this.#now()) throw new DiscordApiError(429);
      for (let delay = this.#globalRetryAt - this.#now(); delay > 0; delay = this.#globalRetryAt - this.#now()) {
        await this.#pause(Math.ceil(delay));
      }
      let response;
      try {
        response = await this.#fetch(`${BASE_URL}${path}`, {
          method, headers, body: payload, signal: AbortSignal.timeout(this.#timeoutMs), redirect: 'error',
        });
      } catch {
        // Abort, DNS, TLS and fetch errors can include sensitive request details.
      }
      if (response?.status === 204) return undefined;
      const data = response ? await response.json().catch(() => null) : null;
      if (response?.ok && data !== null) return data;

      const status = response && !response.ok ? response.status : 502;
      const error = new DiscordApiError(status, data?.code);
      const backoff = 250 * 2 ** attempt;
      if (status === 429) {
        const delay = retryDelay(response, data, backoff);
        const global = data?.global === true || response.headers.get('x-ratelimit-global') === 'true';
        if (global) this.#globalRetryAt = Math.max(this.#globalRetryAt, this.#now() + delay);
        if (guarded || attempt >= 3) throw error;
        if (!global) await this.#pause(delay);
      } else if (!guarded && status >= 500 && status < 600 && attempt < 3) {
        await this.#pause(backoff);
        // A failed POST may already have created the resource. Check its stable identity first.
        if (recover) {
          const existing = await recover();
          if (existing) return existing;
        }
      } else {
        throw error;
      }
    }
  }

  getCurrentUser() { return this.#request('GET', '/users/@me'); }
  getGuild(guildId) { return this.#request('GET', `/guilds/${guildId}?with_counts=true`); }
  getOnboarding(guildId) { return this.#request('GET', `/guilds/${guildId}/onboarding`); }
  getMember(guildId, userId) { return this.#request('GET', `/guilds/${guildId}/members/${userId}`); }
  async listGuildMembers(guildId, { limit = 1000, after } = {}) {
    if (!isSnowflake(guildId) || !Number.isInteger(limit) || limit < 1 || limit > 1000 || (after !== undefined && !isSnowflake(after))) {
      throw new DiscordApiError(400);
    }
    const params = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}) });
    const data = await this.#request('GET', `/guilds/${guildId}/members?${params}`, undefined, undefined, { guarded: true });
    if (!Array.isArray(data) || data.length > limit) throw new DiscordApiError(502);
    // Only retain fields required for live complaint routing.
    return data.map(({ user, roles, pending, communication_disabled_until }) => ({ user: { id: user?.id, bot: user?.bot },
      roles, pending, communication_disabled_until }));
  }
  getRoles(guildId) { return this.#request('GET', `/guilds/${guildId}/roles`); }
  createRole(guildId, data, recover) { return this.#request('POST', `/guilds/${guildId}/roles`, data, recover); }
  updateRole(guildId, roleId, data) { return this.#request('PATCH', `/guilds/${guildId}/roles/${roleId}`, data); }
  reorderRoles(guildId, positions) { return this.#request('PATCH', `/guilds/${guildId}/roles`, positions); }
  grantRole(guildId, userId, roleId) { return this.#request('PUT', `/guilds/${guildId}/members/${userId}/roles/${roleId}`); }
  revokeRole(guildId, userId, roleId) { return this.#request('DELETE', `/guilds/${guildId}/members/${userId}/roles/${roleId}`); }
  getChannels(guildId) { return this.#request('GET', `/guilds/${guildId}/channels`); }
  createChannel(guildId, data, recover) { return this.#request('POST', `/guilds/${guildId}/channels`, data, recover); }
  getChannel(channelId) { return this.#request('GET', `/channels/${channelId}`); }
  updateChannel(channelId, data, options) { return this.#request('PATCH', `/channels/${channelId}`, data, undefined, options); }
  deleteChannel(channelId) { return this.#request('DELETE', `/channels/${channelId}`, undefined, undefined, { guarded: true }); }
  putOverwrite(channelId, id, data) { return this.#request('PUT', `/channels/${channelId}/permissions/${id}`, data, undefined, { guarded: true }); }
  deleteOverwrite(channelId, id) { return this.#request('DELETE', `/channels/${channelId}/permissions/${id}`, undefined, undefined, { guarded: true }); }
  moveMember(guildId, userId, channelId) {
    return this.#request('PATCH', `/guilds/${guildId}/members/${userId}`, { channel_id: channelId }, undefined, { guarded: true });
  }
  getChannelAudits(guildId, after) {
    return this.#request('GET', `/guilds/${guildId}/audit-logs?action_type=11&limit=100&after=${after}`);
  }
  getActiveThreads(guildId) { return this.#request('GET', `/guilds/${guildId}/threads/active`); }
  createForumPost(channelId, data, recover) { return this.#request('POST', `/channels/${channelId}/threads`, data, recover); }
  async getWebhooks(channelId) {
    return (await this.#request('GET', `/channels/${channelId}/webhooks`)).map(webhookMetadata);
  }
  async createWebhook(channelId, data, recover) {
    return webhookMetadata(await this.#request('POST', `/channels/${channelId}/webhooks`, data, recover));
  }
  getMessage(channelId, messageId) { return this.#request('GET', `/channels/${channelId}/messages/${messageId}`); }
  createMessage(channelId, data, options) { return this.#request('POST', `/channels/${channelId}/messages`, data, undefined, options); }
  editMessage(channelId, messageId, data, options) { return this.#request('PATCH', `/channels/${channelId}/messages/${messageId}`, data, undefined, options); }
  createDm(recipientId, options) { return this.#request('POST', '/users/@me/channels', { recipient_id: recipientId }, undefined, options); }
  registerGuildCommands(applicationId, guildId, commands) {
    return this.#request('PUT', `/applications/${applicationId}/guilds/${guildId}/commands`, commands);
  }
}
