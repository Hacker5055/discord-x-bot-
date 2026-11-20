import { AppError, errorFields } from '../lib/errors.js';
import { calendarActions } from './calendar.js';
import { configActions } from './config.js';
import { adminOf, createAdminCore, stale } from './core.js';
import { catalogStatus } from './catalog-status.js';
import { automodMonitor, voiceRooms } from './gateway.js';
import { discussionActions, guideActions } from './portal.js';
import { deliverAnnouncements, incidentActions, publicationActions } from './publication.js';
import { contentActions, ideaActions, moderationActions, ownRequests } from './requests.js';
import { diagnosticActions, restoreLeases, roomActions } from './safety.js';
import { knowledgeActions, staffActions } from './staff.js';
import { rulesActions } from './rules.js';
import { serverActions } from './server.js';
import { ticketActions } from './tickets.js';
import { trainingActions } from './training.js';
import { welcomeActions } from './welcome.js';

export const adminUnavailable = () => new AppError('ADMIN_DISABLED', 'أدوات الإدارة مش جاهزة للتشغيل دلوقتي.', 503);

export function createAdministration(dependencies) {
  const c = createAdminCore(dependencies);
  const ticket = ticketActions(c);
  const guide = guideActions(c);
  const rules = rulesActions(c);
  const server = serverActions(c, { ticket, rules });
  const voice = voiceRooms(c);
  const auto = automodMonitor(c);
  const report = catalogStatus(c);
  const training = trainingActions(c);
  let running;
  async function maintain(guild) {
    if (!c.store) return;
    const snapshot = adminOf(await c.read());
    // A failure in an independent task must not prevent the next lease/maintenance run.
    for (const [task, execute] of [
      ['restore', () => restoreLeases(c, snapshot)], ['announcements', () => deliverAnnouncements(c, snapshot)],
      ['voice', () => voice.cleanup(guild, snapshot)], ['automod', () => auto.flush(snapshot)],
      ['complaints', () => ticket.complaints.tick(snapshot)],
    ]) {
      try { await execute(); }
      catch (error) { c.log.warn('admin_maintenance_failed', { task, ...errorFields(error) }); }
    }
  }
  return {
    core: c, config: configActions(c), ticket: { ...ticket, alerts: ticket.complaints.status }, guide, rules, server, welcome: welcomeActions(c), staff: { ...staffActions(c), practice: training.practice }, kb: knowledgeActions(c),
    mod: moderationActions(c), content: contentActions(c), idea: ideaActions(c), diagnostics: diagnosticActions(c),
    room: roomActions(c), discussion: discussionActions(c), calendar: calendarActions(c), incident: incidentActions(c),
    publication: publicationActions(c), my: { view: ownRequests(c) }, auto, voice, report,
    complaintForm: ticket.complaintForm,
    async modal(i) {
      const match = /^bx:x:complaint:([0-9]{17,20})$/.exec(i.customId);
      if (!match) throw stale();
      return ticket.complain(i, match[1], i.fields.getTextInputValue('details'));
    },
    async button(i) {
      const approve = /^bx:x:server:([0-9]{17,20})$/.exec(i.customId);
      if (approve) return server.confirm(i, approve[1]);
      if (i.customId.startsWith('bx:x:train:')) return training.button(i);
      const match = /^bx:x:(ticket|interest):([a-z]+)$/.exec(i.customId);
      if (!match) throw stale();
      return match[1] === 'ticket' ? ticket.fromCard(i, match[2]) : guide.interest(i, match[2]);
    },
    tick(guild) {
      running ??= maintain(guild).finally(() => { running = undefined; });
      return running;
    },
  };
}
