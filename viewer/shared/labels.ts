// Gmail's folders and label rules, shared by the server and the web front end.

export interface FolderDef {
  id: string; // used in URLs: #/inbox
  name: string; // shown in the sidebar
  label: string | null; // the Gmail label behind it; null = All Mail
  hideIfEmpty?: boolean;
  count?: "unread" | "total"; // which number the sidebar shows
  notes?: boolean; // the Notes folder: threads that have a note, newest note first
}

export const FOLDERS: FolderDef[] = [
  { id: "inbox", name: "Inbox", label: "Inbox", count: "unread" },
  { id: "starred", name: "Starred", label: "Starred" },
  { id: "important", name: "Important", label: "Important" },
  { id: "sent", name: "Sent", label: "Sent" },
  { id: "drafts", name: "Drafts", label: "Drafts", hideIfEmpty: true, count: "total" },
  { id: "chats", name: "Chats", label: "Chat", hideIfEmpty: true },
  { id: "all", name: "All Mail", label: null },
  { id: "spam", name: "Spam", label: "Spam", count: "unread" },
  { id: "trash", name: "Trash", label: "Trash" },
  { id: "notes", name: "Notes", label: null, notes: true, hideIfEmpty: true, count: "total" },
];

export const isNotesView = (view: View) => view === "notes";

/** Labels Gmail uses internally; never shown as user labels. */
export const SYSTEM_LABELS = new Set([
  "Inbox", "Sent", "Drafts", "Spam", "Trash", "Starred", "Important", "Unread", "Chat",
  // Takeout pseudo-labels: Opened = not Unread, Archived = not Inbox.
  "Opened", "Archived",
]);

export const CATEGORY_PREFIX = "Category ";
export const isCategory = (name: string) => name.startsWith(CATEGORY_PREFIX);
export const categoryName = (name: string) => name.slice(CATEGORY_PREFIX.length);
export const isUserLabel = (name: string) => !SYSTEM_LABELS.has(name) && !isCategory(name);

/** A view is a folder id ("inbox") or "label:<label name>" (user labels and categories). */
export type View = string;

export function viewLabel(view: View): string | null {
  if (view.startsWith("label:")) return view.slice("label:".length);
  const f = FOLDERS.find((f) => f.id === view);
  if (!f) throw new Error(`unknown view: ${view}`);
  return f.label;
}

/** Which messages a view (and actions taken in it) can see: Trash and Spam hide mail everywhere else. */
export function viewContext(view: View): "trash" | "spam" | "normal" {
  return view === "trash" ? "trash" : view === "spam" ? "spam" : "normal";
}

export function viewTitle(view: View): string {
  if (view.startsWith("label:")) {
    const name = view.slice("label:".length);
    return isCategory(name) ? categoryName(name) : name;
  }
  return FOLDERS.find((f) => f.id === view)?.name ?? view;
}

export interface LabelChange {
  add: string[];
  remove: string[];
}

export interface RemoveAction extends LabelChange {
  button: string; // toolbar button text
  done: (n: number) => string; // toast text
}

const conv = (n: number) => (n === 1 ? "Conversation" : `${n} conversations`);

/**
 * What `y` does in each view, as in Gmail: take the conversation out of this view.
 * Returns null where `y` does nothing (All Mail, Sent, Drafts, Chats).
 */
export function removeAction(view: View): RemoveAction | null {
  switch (view) {
    case "inbox":
      return { add: [], remove: ["Inbox"], button: "Archive", done: (n) => `${conv(n)} archived.` };
    case "starred":
      return { add: [], remove: ["Starred"], button: "Unstar", done: (n) => `${conv(n)} unstarred.` };
    case "important":
      return { add: [], remove: ["Important"], button: "Mark not important", done: (n) => `${conv(n)} marked as not important.` };
    case "trash":
      return { add: ["Inbox"], remove: ["Trash"], button: "Move to Inbox", done: (n) => `${conv(n)} moved to Inbox.` };
    case "spam":
      return { add: ["Inbox"], remove: ["Spam"], button: "Not spam", done: (n) => `${conv(n)} moved to Inbox.` };
  }
  if (view.startsWith("label:")) {
    const name = view.slice("label:".length);
    const shown = isCategory(name) ? categoryName(name) : name;
    return { add: [], remove: [name], button: `Remove label "${shown}"`, done: (n) => `${conv(n)} removed from ${shown}.` };
  }
  return null;
}

/**
 * Apply a label change to one message's label set, keeping Takeout's pseudo-label pairs
 * consistent: Inbox ⟷ Archived and Unread ⟷ Opened.
 */
export function applyChange(labels: Set<string>, change: LabelChange): Set<string> {
  const next = new Set(labels);
  for (const l of change.remove) next.delete(l);
  for (const l of change.add) next.add(l);
  const pairs: [string, string][] = [
    ["Inbox", "Archived"],
    ["Unread", "Opened"],
  ];
  for (const [label, opposite] of pairs) {
    if (labels.has(label) !== next.has(label)) {
      if (next.has(label)) next.delete(opposite);
      else next.add(opposite);
    }
  }
  return next;
}
