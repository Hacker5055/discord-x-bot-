import { createHash } from 'node:crypto';
import { adminOf, audit, live, stale, TEXT_ROOMS } from '../admin/core.js';
import { resolveRoles } from '../discord/state.js';
import { ROLE_KEYS } from '../lib/catalog.js';
import { AppError } from '../lib/errors.js';
import { assertBridge, siteSession, staffAccess } from './session.js';

function permitted(check) {
  try { check(); return true; }
  catch (error) { if (error instanceof AppError) return false; throw error; }
}

export function createSiteBridge({ admin, getHealth }) {
  const c = admin.core;
  const tickets = admin.ticket.site;
  async function profile({ discordId }) {
    const s = await siteSession(c, discordId, { profile: true });
    const confirmed = s.membership === 'member';
    const roles = confirmed ? resolveRoles(s.w.allRoles, c.config) : {};
    const canUseTickets = confirmed && s.a.enabled && permitted(() => c.authorize(s.w, s.a, { by: s.by, member: s.member }));
    const intake = confirmed ? tickets.intakeStatus(s) : null;
    const canOpenTicket = Boolean(canUseTickets && intake.configured && !intake.paused && permitted(() => {
      const channel = c.findRoom(s.w, s.a.rooms.ticket_panel, TEXT_ROOMS);
      c.authorize(s.w, s.a, { by: s.by, member: s.member, channel });
    }));
    return { discordId, guildId: c.guildId, membership: s.membership,
      roles: ROLE_KEYS.filter((key) => roles[key] && s.member.roles.includes(roles[key].id)),
      capabilities: { canUseTickets: Boolean(canUseTickets), canOpenTicket, canViewDashboard: confirmed && permitted(() => staffAccess(c, s)) } };
  }

  async function dashboard({ discordId }) {
    const s = await siteSession(c, discordId, { staff: true, overview: true });
    const a = adminOf(await c.read());
    assertBridge(c, a);
    if (a.version !== s.a.version) throw stale();
    const health = await getHealth();
    const ids = Object.keys(s.state.catalog).sort();
    return {
      observedAt: c.now(),
      health: { ready: health.ok === true, gatewayReady: health.bot?.ready === true, uptimeSeconds: health.uptime,
        memberCount: health.guild?.memberCount ?? null },
      adminEnabled: s.a.enabled,
      welcomeEnabled: Boolean(c.config.welcomeGateway && s.a.welcome?.enabled),
      tickets: { ...tickets.intakeStatus(s), counts: tickets.counts(s), canSetIntake: s.owner && s.a.enabled },
      catalog: { count: ids.length, idsSha256: createHash('sha256').update(ids.join('\n')).digest('hex'),
        lastAccepted: s.state.catalogMeta ?? null, lastRejectedSinceBoot: c.catalogMonitor?.lastError() ?? null },
    };
  }

  async function intake({ discordId, paused }) {
    const s = await siteSession(c, discordId, { staff: true, ownerOnly: true });
    return c.edit((a) => {
      assertBridge(c, a);
      live(a);
      if (Boolean(a.paused.tickets) !== paused) {
        if (paused) a.paused.tickets = true;
        else delete a.paused.tickets;
        a.version += 1;
        audit(a, 'ops', paused ? 'module_paused' : 'module_resumed', s.by, 'tickets', c.now());
      }
      return { paused };
    }, s);
  }

  const handlers = new Map(Object.entries({
    profile, dashboard,
    'tickets/list': (data) => tickets.list(data, false),
    'tickets/open': tickets.open,
    'tickets/detail': (data) => tickets.detail(data, false),
    'tickets/reply': (data) => tickets.reply(data, false),
    'staff/tickets/list': (data) => tickets.list(data, true),
    'staff/tickets/detail': (data) => tickets.detail(data, true),
    'staff/tickets/claim': tickets.claim,
    'staff/tickets/reply': (data) => tickets.reply(data, true),
    'staff/tickets/close': tickets.close,
    'staff/tickets/intake': intake,
  }));
  return { handle: (action, data) => handlers.get(action)(data) };
}
