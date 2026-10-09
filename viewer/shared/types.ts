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
