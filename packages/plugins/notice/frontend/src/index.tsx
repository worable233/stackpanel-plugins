import type { FrontendPackage, FrontendPageProps } from '@stackpanel/sdk';
import type { ReactElement } from 'react';
import { z } from 'zod';
import { messages, t } from './i18n.js';

const announcementSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  published: z.boolean(),
  sortOrder: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listSchema = z.object({ announcements: z.array(announcementSchema) });

/** Public page rendered by the web shell under /notice. */
function NoticePage(props: FrontendPageProps): ReactElement {
  const tr = t(props.locale);
  const result = props.data.announcements as z.infer<typeof listSchema> | undefined;
  const announcements = result?.announcements ?? [];
  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <div>
        <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
          {tr('page.title')}
        </h1>
      </div>
      {announcements.length ? (
        <ul className="mt-8 space-y-4">
          {announcements.map((announcement) => (
            <li key={announcement.id} className="rounded-2xl border bg-card p-5 shadow-sm">
              <div className="flex items-center justify-between gap-4">
                <h2 className="text-base font-semibold tracking-tight">{announcement.title}</h2>
                <time
                  className="shrink-0 text-xs text-muted-foreground"
                  dateTime={announcement.createdAt}
                >
                  {announcement.createdAt.slice(0, 10)}
                </time>
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                {announcement.content}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-8 text-sm text-muted-foreground">{tr('page.empty')}</p>
      )}
    </main>
  );
}

export const frontend: FrontendPackage = {
  locales: ['zh-CN', 'zh-TW', 'zh-HK', 'en-US'],
  messages,
  pages: [
    {
      path: '/notice',
      component: 'notice/index',
      data: [{ fetch: { path: '/notices' }, as: 'announcements' }],
    },
  ],
  pageComponents: { 'notice/index': NoticePage },
  ui: {
    actions: [
      {
        id: 'notice.create',
        method: 'POST',
        path: '/notice/admin/announcements',
        permission: 'notice.admin',
        successFeedback: { messageKey: 'feedback.created' },
        input: [
          { name: 'title', type: 'string', required: true, maxLength: 191 },
          { name: 'content', type: 'string', required: true, maxLength: 5000 },
          { name: 'sortOrder', type: 'integer', default: 0, min: 0, max: 9999 },
          { name: 'published', type: 'boolean', default: true },
        ],
      },
      {
        id: 'notice.toggle',
        method: 'PATCH',
        path: '/notice/admin/announcements/:id',
        permission: 'notice.admin',
        // The list row already shows the new published state.
        silent: true,
        input: [
          { name: 'id', type: 'string', required: true, maxLength: 191 },
          { name: 'published', type: 'boolean', required: true },
        ],
      },
      {
        id: 'notice.delete',
        method: 'DELETE',
        path: '/notice/admin/announcements/:id',
        permission: 'notice.admin',
        successFeedback: { messageKey: 'feedback.deleted' },
        input: [{ name: 'id', type: 'string', required: true, maxLength: 191 }],
      },
    ],
    adminRoutes: [
      {
        path: '/overview',
        component: 'admin/overview',
        permission: 'notice.admin',
        nav: { labelKey: 'nav.label', groupKey: 'nav.group', order: 40 },
        data: [{ fetch: { path: '/notice/admin/announcements' }, as: 'announcements' }],
      },
    ],
  },
};

export default frontend;
