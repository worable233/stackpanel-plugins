'use client';

import type { AdminPageComponentProps } from '@stackpanel/sdk';
import { PageHeader, Select } from '@stackpanel/ui';
import type { ReactElement } from 'react';
import { Megaphone } from 'lucide-react';
import { t } from './i18n.js';

interface Announcement {
  id: string;
  title: string;
  content: string;
  published: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface AnnouncementList {
  announcements: Announcement[];
}

/** Admin overview page: create + manage announcements. */
function NoticeAdminPage(props: AdminPageComponentProps): ReactElement {
  const tr = t(props.locale);
  const result = props.data.announcements as AnnouncementList | undefined;
  const announcements = result?.announcements ?? [];
  const create = props.actions['notice.create'];
  const toggle = props.actions['notice.toggle'];
  const del = props.actions['notice.delete'];
  return (
    <main className="w-full space-y-8">
      <PageHeader title={tr('admin.title')} />

      {create ? (
        <form action={create} className="grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-2">
          <Field label={tr('admin.field.title')} name="title" required />
          <label className="grid gap-1 text-sm sm:col-span-2">
            <span>{tr('admin.field.content')}</span>
            <textarea
              name="content"
              rows={4}
              required
              className="h-auto rounded-lg border bg-background px-3 py-2"
            />
          </label>
          <Field
            label={tr('admin.field.sortOrder')}
            name="sortOrder"
            type="number"
            min="0"
            defaultValue="0"
          />
          <label className="grid gap-1 text-sm">
            <span>{tr('admin.field.status')}</span>
            <Select
              name="published"
              defaultValue="true"
              className="h-9 rounded-lg border bg-background px-3"
            >
              <option value="true">{tr('admin.state.published')}</option>
              <option value="false">{tr('admin.state.draft')}</option>
            </Select>
          </label>
          <button
            type="submit"
            className="h-9 w-fit rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground sm:col-span-2"
          >
            {tr('admin.submit')}
          </button>
        </form>
      ) : null}

      {announcements.length ? (
        <ul className="space-y-3">
          {announcements.map((announcement) => (
            <li key={announcement.id} className="rounded-lg border bg-card p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{announcement.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {announcement.content}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {toggle ? (
                    <form action={toggle}>
                      <input type="hidden" name="id" value={announcement.id} />
                      <input
                        type="hidden"
                        name="published"
                        value={announcement.published ? 'false' : 'true'}
                      />
                      <button
                        type="submit"
                        className="h-8 rounded-lg border bg-background px-2.5 text-xs hover:bg-muted"
                      >
                        {announcement.published
                          ? tr('admin.unpublish')
                          : tr('admin.state.published')}
                      </button>
                    </form>
                  ) : null}
                  {del ? (
                    <form action={del}>
                      <input type="hidden" name="id" value={announcement.id} />
                      <button type="submit" className="text-xs text-destructive hover:underline">
                        {tr('admin.delete')}
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
              <span
                className={`mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  announcement.published
                    ? 'bg-success/10 text-success'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <span className="size-1.5 rounded-full bg-current" />
                {announcement.published ? tr('admin.badge.published') : tr('admin.badge.draft')}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col items-center rounded-2xl border border-dashed px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Megaphone className="size-5" />
          </span>
          <p className="mt-4 text-sm text-muted-foreground">{tr('admin.empty')}</p>
        </div>
      )}
    </main>
  );
}

function Field({
  label,
  name,
  type = 'text',
  min,
  defaultValue,
  required = false,
}: {
  label: string;
  name: string;
  type?: string;
  min?: string;
  defaultValue?: string;
  required?: boolean;
}): ReactElement {
  return (
    <label className="grid gap-1 text-sm">
      <span>{label}</span>
      <input
        name={name}
        type={type}
        min={min}
        defaultValue={defaultValue}
        required={required}
        className="h-9 rounded-lg border bg-background px-3"
      />
    </label>
  );
}

export const adminPages = {
  'admin/overview': NoticeAdminPage,
} as const;
