// Writes a synthetic Takeout-style mbox (no real mail) to stdout.
// Rebuild the committed test archive with ./rebuild-archive.sh.

import fs from "node:fs";
import path from "node:path";

const ME = "Pat Owner <me@example.com>";
const ALICE = "Alice Adams <alice@example.com>";
const BOB = "Bob Brown <bob@example.com>";
const CAROL = "Carol Chen <carol@example.com>";
const SHOP = "Deals <news@shop.example>";

interface Msg {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  labels: string[];
  text?: string;
  html?: string;
  attachments?: { name: string; type: string; data: Buffer; cid?: string }[];
}

let nextId = 1700000000000000001n;
let clock = Date.UTC(2024, 0, 1, 9, 0, 0);
const out: string[] = [];

function b64(data: Buffer): string {
  return data.toString("base64").replace(/.{76}/g, "$&\r\n");
}

function encodeWord(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
}

function body(m: Msg, boundary: string): string[] {
  const textPart = [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from(m.text ?? "")),
  ];
  const htmlPart = ["Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", b64(Buffer.from(m.html ?? ""))];
  const atts = m.attachments ?? [];
  const inline = atts.filter((a) => a.cid);
  const files = atts.filter((a) => !a.cid);
  const part = (a: { name: string; type: string; data: Buffer; cid?: string }) => [
    `Content-Type: ${a.type}; name="${a.name}"`,
    a.cid ? `Content-ID: <${a.cid}>` : "",
    `Content-Disposition: ${a.cid ? "inline" : "attachment"}; filename="${a.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64(a.data),
  ].filter((l, i) => l !== "" || i === 4);

  let alt: string[];
  if (m.html !== undefined && m.text !== undefined) {
    alt = [`Content-Type: multipart/alternative; boundary="${boundary}-alt"`, "", `--${boundary}-alt`, ...textPart, `--${boundary}-alt`, ...htmlPart, `--${boundary}-alt--`];
  } else if (m.html !== undefined) {
    alt = htmlPart;
  } else {
    alt = textPart;
  }
  if (inline.length) {
    alt = [`Content-Type: multipart/related; boundary="${boundary}-rel"`, "", `--${boundary}-rel`, ...alt, ...inline.flatMap((a) => [`--${boundary}-rel`, ...part(a)]), `--${boundary}-rel--`];
  }
  if (!files.length) return alt;
  return [`Content-Type: multipart/mixed; boundary="${boundary}-mix"`, "", `--${boundary}-mix`, ...alt, ...files.flatMap((a) => [`--${boundary}-mix`, ...part(a)]), `--${boundary}-mix--`];
}

/** Add a thread; returns its thread ID. Each message is one hour after the previous one. */
function thread(msgs: Msg[]): string {
  const threadId = nextId.toString();
  let firstMsgId = "";
  for (const m of msgs) {
    const id = (nextId++).toString();
    clock += 3600_000;
    const date = new Date(clock);
    const msgId = `<${id}@example.com>`;
    const headers = [
      `X-GM-THRID: ${threadId}`,
      `X-Gmail-Labels: ${m.labels.map((l) => (l.includes(",") ? `"${l}"` : l)).join(",")}`,
      `From: ${encodeWord(m.from)}`,
      `To: ${m.to}`,
      ...(m.cc ? [`Cc: ${m.cc}`] : []),
      `Subject: ${encodeWord(m.subject)}`,
      `Date: ${date.toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: ${msgId}`,
      ...(firstMsgId ? [`In-Reply-To: ${firstMsgId}`, `References: ${firstMsgId}`] : []),
      "MIME-Version: 1.0",
    ];
    firstMsgId ||= msgId;
    const lines = [...headers, ...body(m, `b${id}`)];
    const from_ = date.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, "$1 $3 $2 $5 +0000 $4");
    out.push(`From ${id}@xxx ${from_}`, ...lines.map((l) => (/^>*From /.test(l) ? ">" + l : l)), "");
  }
  return threadId;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUHEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".replace("SUHE", "SUhE"),
  "base64",
);

const media = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "media", name));
const pdf = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
    "4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 50 Td (Meeting minutes) Tj ET\nendstream endobj\n" +
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');

// Media first (the oldest mail), so the threads the other tests look at stay the newest.
thread([{ from: CAROL, to: ME, subject: "Holiday media", labels: ["Archived", "Opened", "Media"], text: "Photos, a song, a clip and the minutes.\n",
          attachments: [
            { name: "sunset.jpg", type: "image/jpeg", data: media("sunset.jpg") },
            { name: "beach.png", type: "image/png", data: media("beach.png") },
            { name: "photo.png", type: "application/octet-stream", data: png },
            { name: "voice-memo.mp3", type: "audio/mpeg", data: media("tone.mp3") },
            { name: "clip.mp4", type: "video/mp4", data: media("clip.mp4") },
            { name: "minutes.pdf", type: "application/pdf", data: pdf },
            { name: "server.log", type: "text/plain", data: Buffer.from("<b>not html</b>\nline 2\n") },
            { name: "drawing.svg", type: "image/svg+xml", data: svg },
          ] }]);
thread([{ from: BOB, to: ME, subject: "Fwd: Holiday media", labels: ["Archived", "Opened", "Media"], text: "Same sunset again.\n",
          attachments: [{ name: "sunset.jpg", type: "image/jpeg", data: media("sunset.jpg") }] }]);

// Filler next, so the interesting threads are the newest.
for (let i = 1; i <= 55; i++) {
  thread([{ from: SHOP, to: ME, subject: `Weekly deals #${i}`, labels: ["Archived", "Opened", "Category Promotions", "Newsletters"], text: `Deal number ${i}.\n` }]);
}
thread([{ from: ALICE, to: ME, subject: "Quarterly report", labels: ["Archived", "Opened", "Work"], text: "Report attached.\n", attachments: [{ name: "report.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: Buffer.from("fake xlsx") }, { name: "notes.txt", type: "text/plain", data: Buffer.from("same name 1") }, { name: "notes.txt", type: "text/plain", data: Buffer.from("same name 2") }] },
        { from: ME, to: ALICE, subject: "Re: Quarterly report", labels: ["Sent", "Opened", "Work"], text: "Thanks!\n\nOn Monday Alice wrote:\n> Report attached.\n" }]);
thread([{ from: CAROL, to: ME, subject: "Project kickoff", labels: ["Archived", "Opened", "Work/Projects"], text: "Kickoff is Tuesday.\n" }]);
thread([{ from: BOB, to: ME, subject: "Pancake recipe", labels: ["Archived", "Opened", "Starred"], text: "Flour, eggs, milk.\n" }]);
thread([{ from: ME, to: CAROL, subject: "Question about the invoice", labels: ["Sent", "Opened"], text: "Is invoice 42 paid?\n" }]);
thread([{ from: ME, to: BOB, subject: "Draft idea", labels: ["Drafts", "Opened"], text: "Half-written thought\n" }]);
thread([{ from: "Dana <dana@example.com>", to: ME, subject: "Chat with Dana", labels: ["Chat", "Opened"], text: "hey, lunch?\n" }]);
thread([{ from: "Prize Office <win@spam.example>", to: ME, subject: "You won!!!", labels: ["Spam", "Unread"], text: "Claim now.\n" }]);
thread([{ from: SHOP, to: ME, subject: "Old coupon", labels: ["Trash", "Opened", "Category Promotions"], text: "Expired coupon.\n", attachments: [{ name: "coupon.png", type: "image/png", data: png }] }]);
thread([{ from: ALICE, to: ME, subject: "Mixed thread", labels: ["Inbox", "Opened"], text: "First message stays.\n" },
        { from: ALICE, to: ME, subject: "Re: Mixed thread", labels: ["Trash", "Opened"], text: "Second message was trashed.\n" }]);
thread([{ from: "Oma <oma@example.de>", to: ME, subject: "Grüße aus Köln ☕", labels: ["Inbox", "Opened", "Family"], text: "Liebe Grüße!\n" }]);
thread([{ from: SHOP, to: ME, subject: "Big sale", labels: ["Inbox", "Opened", "Category Promotions"],
          text: "Big sale today.\n",
          html: '<html><head><style>p{color:#333}</style><script>window.parent.hacked = true;</script></head><body>' +
                '<p onclick="alert(1)">Big <b>sale</b> today!</p><img src="https://tracker.example/pixel.gif" alt="remote">' +
                '<img src="cid:logo@shop" alt="logo"><a href="https://shop.example/deal">See deal</a>' +
                '<a href="javascript:alert(2)">bad link</a></body></html>',
          attachments: [{ name: "logo.png", type: "image/png", data: png, cid: "logo@shop" }] }]);
thread([{ from: ALICE, to: ME, subject: "Trip planning", labels: ["Inbox", "Opened", "Travel/2024", "Category Personal"], text: "Where should we go?\n", attachments: [{ name: "itinerary.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4 fake") }] },
        { from: ME, to: ALICE, subject: "Re: Trip planning", labels: ["Sent", "Opened", "Travel/2024"], text: "Lisbon?\n" },
        { from: BOB, to: ME, cc: ALICE, subject: "Re: Trip planning", labels: ["Inbox", "Unread", "Important", "Travel/2024", "Category Personal"], text: "Count me in.\nFrom Bob\n" }]);
thread([{ from: ALICE, to: ME, subject: "Welcome to the archive", labels: ["Inbox", "Unread", "Important", "Category Personal"], text: "This is the newest message.\n" }]);

process.stdout.write(out.join("\r\n") + "\r\n");
