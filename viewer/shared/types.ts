// JSON shapes of the API, shared by the server and the web front end.

import type { ChosenColors } from "./labelColors.ts";

export interface Session {
  me: string[];
  schemaVersion: number;
  readOnly: boolean;
  archiveDir: string;
}

export interface SidebarItem {
  view: string; // e.g. "inbox" or "label:Work"
  name: string; // display name; for nested labels the full "Parent/Child" path
  count: number | null; // unread (or total for Drafts); null = show nothing
  messages?: number; // messages carrying the label (user labels only)
  labelId?: number;
}

export interface Sidebar {
  folders: SidebarItem[];
  categories: SidebarItem[];
  labels: SidebarItem[];
  labelColors: ChosenColors; // only the colors chosen in the viewer; see shared/labelColors.ts
}

export interface Participant {
  name: string; // first name, or "me"
  unread: boolean;
}

export interface ThreadSummary {
  threadId: string;
  subject: string;
  snippet: string;
  date: number | null; // epoch seconds of the newest message in the view
  participants: Participant[];
  toPrefix: boolean; // Sent/Drafts: participants are recipients ("To: Alice")
  messageCount: number;
  unread: boolean;
  starred: boolean;
  important: boolean;
  hasAttachments: boolean;
  labels: string[]; // chips: user labels (+ "Inbox" outside the Inbox)
  hasNote: boolean;
  noteFirstLine: string | null; // the note's first non-empty line (tooltip; the Notes folder's snippet)
}

export interface ThreadList {
  view: string;
  page: number;
  pageSize: number;
  total: number;
  threads: ThreadSummary[];
}

export interface Address {
  name: string;
  addr: string;
}

export interface AttachmentInfo {
  id: number;
  filename: string | null;
  contentType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
}

export interface MessageDetail {
  id: number;
  gmailId: string;
  from: Address | null;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  date: number | null;
  subject: string;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  unread: boolean;
  starred: boolean;
  labels: string[];
  inContext: boolean; // false: trashed/spam message seen from another view (Gmail hides it)
  attachments: AttachmentInfo[];
}

export interface ThreadDetail {
  threadId: string;
  subject: string;
  labels: string[]; // user-label chips for the whole thread
  messages: MessageDetail[];
  note: NoteInfo | null;
}

/** A thread's note. Times are Unix milliseconds. */
export interface NoteInfo {
  body: string;
  createdAt: number;
  updatedAt: number;
}

export interface NoteSaveResult {
  deleted: boolean;
  note: NoteInfo | null;
}

/** One message's label change, as applied; Undo applies the reverse. */
export interface AppliedChange {
  messageId: number;
  added: string[];
  removed: string[];
}

export interface ModifyResult {
  changes: AppliedChange[];
  threads: number;
}

export interface TrashSummary {
  messages: number;
  threads: number;
  attachments: number;
  attachmentBytes: number;
  notes: number; // notes deleted with their thread (only threads with no message left)
}

// ------------------------------------------------------------------ admin page

export interface AdminPerson {
  addr: string; // an address, or a domain when grouped by domain
  name: string; // the name used most often
  count: number; // messages
  addresses: number; // distinct addresses (more than 1 only when grouped by domain)
  to: number;
  cc: number;
  bcc: number;
  last: number | null; // epoch seconds
  attachments: number; // received from this sender (non-inline)
  attachmentBytes: number;
}

export interface AdminOverview {
  messages: number;
  messageBytes: number;
  threads: number;
  unread: number;
  starred: number;
  firstDate: number | null;
  lastDate: number | null;
  attachments: number; // in the archive, not inline
  attachmentBytes: number;
  inlineImages: number;
  inlineBytes: number;
  deletedAttachments: number;
  deletedBytes: number;
  dbBytes: number;
  walBytes: number;
  freeBytes: number; // free pages inside mail.db (Compact recovers them)
  parseErrorCount: number;
  parseErrors: { id: number; date: number | null; fromName: string | null; fromAddr: string | null; subject: string | null; threadId: string; error: string }[];
  notes: number;
  topSenders: AdminPerson[];
}

export interface AdminLabel {
  id: number;
  name: string;
  messages: number;
  threads: number;
  unread: number; // unread messages
}

export interface AdminImport {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  sources: string[]; // file names
  toolVersion: string | null;
  counts: { seen: number; inserted: number; labelsChanged: number; unchanged: number; skipped: number; errors: number; keptLocal: number; deletedSkipped: number };
}

export interface AdminList {
  listId: string;
  name: string | null; // the name used most often
  messages: number;
  unread: number;
  first: number | null;
  last: number | null;
  bytes: number;
}

export interface AdminPersonDetail {
  addr: string;
  names: { name: string; n: number }[];
  first: number | null;
  last: number | null;
  messages: number;
  years: { year: number; received: number; sent: number }[];
  labels: { name: string; n: number }[]; // user labels on their mail, top 10
  attachments: { id: number; filename: string | null; size: number; contentType: string | null; threadId: string; date: number | null; subject: string | null }[];
}
