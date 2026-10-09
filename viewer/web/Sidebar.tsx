// Left sidebar: folders, a collapsed Categories group, then user labels as a tree.
import { useState } from "react";
import type { Sidebar as SidebarData, SidebarItem } from "../shared/types.ts";
import { go } from "./route.ts";

const ICONS: Record<string, string> = {
  inbox: "📥",
  starred: "⭐",
  important: "🏷️",
  sent: "📤",
  drafts: "📝",
  chats: "💬",
  all: "📚",
  spam: "⚠️",
  trash: "🗑️",
};

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function save(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* private window: just don't remember */
  }
}

function Item({ item, active, label, depth = 0, icon, toggle, onDelete }: {
  item: SidebarItem;
  active: boolean;
  label: string;
  depth?: number;
  icon?: string;
  toggle?: { open: boolean; onClick: () => void };
  onDelete?: (item: SidebarItem) => void;
}) {
  return (
    <li className={`nav-item${active ? " active" : ""}${item.count && item.view !== "drafts" ? " has-unread" : ""}`} style={{ paddingLeft: 12 + depth * 14 }}>
      {toggle ? (
        <button className="tree-toggle" aria-label={toggle.open ? "Collapse" : "Expand"} onClick={toggle.onClick}>
          {toggle.open ? "▾" : "▸"}
        </button>
      ) : (
        <span className="tree-toggle" />
      )}
      <a href="#" onClick={(e) => { e.preventDefault(); go({ view: item.view }); }} title={item.name}>
        {icon && <span className="nav-icon" aria-hidden>{icon}</span>}
        <span className="nav-name">{label}</span>
        {item.count ? <span className="nav-count">{item.count.toLocaleString()}</span> : null}
      </a>
      {onDelete && (
        <button className="nav-delete" title={`Delete label "${item.name}"`} onClick={() => onDelete(item)}>
          ✕
        </button>
      )}
    </li>
  );
}

interface TreeNode {
  name: string; // last path segment
  item?: SidebarItem; // undefined for a parent that is not itself a label
  children: TreeNode[];
}

function buildTree(labels: SidebarItem[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const item of labels) {
    let level = root;
    const parts = item.name.split("/");
    parts.forEach((part, i) => {
      let node = level.find((n) => n.name === part);
      if (!node) {
        node = { name: part, children: [] };
        level.push(node);
      }
      if (i === parts.length - 1) node.item = item;
      level = node.children;
    });
  }
  return root;
}

export function Sidebar({ data, view, onDeleteLabel }: { data: SidebarData | null; view: string; onDeleteLabel?: (item: SidebarItem) => void }) {
  const [catsOpen, setCatsOpen] = useState(() => load("sidebar.categories", false));
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!data) return <nav className="sidebar" />;

  const renderTree = (nodes: TreeNode[], depth: number, prefix: string): React.ReactNode[] =>
    nodes.flatMap((n) => {
      const path = prefix ? `${prefix}/${n.name}` : n.name;
      const open = !closed.has(path);
      const item = n.item ?? { view: `label:${path}`, name: path, count: null };
      const toggle = n.children.length
        ? { open, onClick: () => setClosed((s) => { const next = new Set(s); if (open) next.add(path); else next.delete(path); return next; }) }
        : undefined;
      return [
        <Item key={path} item={item} label={n.name} depth={depth} active={view === item.view} toggle={toggle}
          onDelete={n.item && onDeleteLabel ? onDeleteLabel : undefined} />,
        ...(open ? renderTree(n.children, depth + 1, path) : []),
      ];
    });

  return (
    <nav className="sidebar" aria-label="Folders and labels">
      <ul>
        {data.folders.map((f) => (
          <Item key={f.view} item={f} label={f.name} icon={ICONS[f.view]} active={view === f.view} />
        ))}
      </ul>
      {data.categories.length > 0 && (
        <ul>
          <li className="nav-group">
            <button onClick={() => { setCatsOpen(!catsOpen); save("sidebar.categories", !catsOpen); }}>
              {catsOpen ? "▾" : "▸"} Categories
            </button>
          </li>
          {catsOpen && data.categories.map((c) => <Item key={c.view} item={c} label={c.name} depth={1} active={view === c.view} />)}
        </ul>
      )}
      {data.labels.length > 0 && (
        <ul>
          <li className="nav-heading">Labels</li>
          {renderTree(buildTree(data.labels), 0, "")}
        </ul>
      )}
    </nav>
  );
}
