import type { TicketWorkspaceLabels } from '@stackpanel/ui';
import { t } from './i18n.js';

/**
 * The ticket plugin owns this copy because TicketWorkspace is a host primitive
 * and cannot resolve plugin-local translations itself. Build the label object
 * from the package catalog in the host's resolved locale.
 */
export function ticketWorkspaceLabels(locale?: string): TicketWorkspaceLabels {
  const tr = t(locale);
  return {
    sectionAria: tr('workspace.sectionAria'),
    listAria: tr('workspace.listAria'),
    myTicketsAria: tr('workspace.myTicketsAria'),
    title: tr('workspace.title'),
    adminTitle: tr('workspace.adminTitle'),
    newTicketAria: tr('workspace.newTicketAria'),
    searchAria: tr('workspace.searchAria'),
    searchPlaceholder: tr('workspace.searchPlaceholder'),
    emptySearch: tr('workspace.emptySearch'),
    empty: tr('workspace.empty'),
    unknownUser: tr('workspace.unknownUser'),
    pickPrompt: tr('workspace.pickPrompt'),
    backToListAria: tr('workspace.backToListAria'),
    newTitle: tr('workspace.newTitle'),
    subjectLabel: tr('workspace.subjectLabel'),
    subjectPlaceholder: tr('workspace.subjectPlaceholder'),
    bodyLabel: tr('workspace.bodyLabel'),
    bodyPlaceholder: tr('workspace.bodyPlaceholder'),
    cancel: tr('workspace.cancel'),
    submit: tr('workspace.submit'),
    sending: tr('workspace.sending'),
    replyPlaceholder: tr('workspace.replyPlaceholder'),
    replyAria: tr('workspace.replyAria'),
    send: tr('workspace.send'),
    closed: tr('workspace.closed'),
    notFound: tr('workspace.notFound'),
    statusLabel: tr('workspace.statusLabel'),
    priorityLabel: tr('workspace.priorityLabel'),
    assigneeLabel: tr('workspace.assigneeLabel'),
    assigneePlaceholder: tr('workspace.assigneePlaceholder'),
    save: tr('workspace.save'),
    conversationAria: tr('workspace.conversationAria'),
    scrollLatestAria: tr('workspace.scrollLatestAria'),
    latest: tr('workspace.latest'),
    selfAuthor: tr('workspace.selfAuthor'),
    staffAuthor: tr('workspace.staffAuthor'),
    statuses: {
      OPEN: tr('status.OPEN'),
      IN_PROGRESS: tr('status.IN_PROGRESS'),
      RESOLVED: tr('status.RESOLVED'),
      CLOSED: tr('status.CLOSED'),
    },
    priorities: {
      LOW: tr('priority.LOW'),
      NORMAL: tr('priority.NORMAL'),
      HIGH: tr('priority.HIGH'),
      URGENT: tr('priority.URGENT'),
    },
  };
}
