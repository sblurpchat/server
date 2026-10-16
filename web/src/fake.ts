// In-memory community servers for ?fake=1: real Connect services over createRouterTransport,
// seeded with three joined communities and one to discover, plus simulated activity.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import {
  AttachmentSchema,
  BotService,
  ChannelKind,
  ChannelSchema,
  ChatService,
  EventSchema,
  GetServerInfoResponseSchema,
  MemberKind,
  MemberRole,
  MemberSchema,
  MessageSchema,
  Presence,
  ReadStateSchema,
  ServerService,
  type Attachment,
  type Channel,
  type Event,
  type GetServerInfoResponse,
  type Member,
  type Message,
  type ReadState,
} from "./gen/sblurp/v1/sblurp_pb";
import { encodeMentions, mentionsMe } from "./logic";

type Extra = {
  replies?: [number, string, string][];
  react?: Record<string, string[]>;
  image?: [string, string, number, number];
  file?: [string, string, number];
  edited?: boolean;
};
type Line = [minutesAgo: number, user: string, text: string, extra?: Extra];
interface Seed {
  url: string;
  name: string;
  description: string;
  accent: string;
  icon: string;
  joined: boolean;
  members: [username: string, name: string, role: MemberRole, presence: Presence, bio: string, status?: string, bot?: true][];
  channels: [category: string, name: string, topic: string][];
  dms: string[][];
  messages: Record<string, Line[]>;
  unread: Record<string, number>;
  chatter: [channel: string, user: string, text: string][];
}

const { OWNER, ADMIN, MODERATOR, MEMBER } = MemberRole;
const { ONLINE, AWAY, OFFLINE } = Presence;
const H = 60;
const D = 24 * H;

const SEEDS: Seed[] = [
  {
    url: "https://community.sblurp.chat",
    name: "Sblurp Community",
    description: "Where people who use Sblurp help each other, share what they build, and argue about fonts.",
    accent: "#3550F0",
    icon: "/fake/sblurp.svg",
    joined: true,
    members: [
      ["ian", "Ian Langworth", OWNER, ONLINE, "Making Sblurp. Ask me about the rail.", "Shipping the web client"],
      ["ana", "Ana Ruiz", ADMIN, ONLINE, "Design systems, type, and too much cold brew.", "Kerning things"],
      ["priya", "Priya Natarajan", MODERATOR, ONLINE, "Backend. SQLite apologist."],
      ["marcus", "Marcus Bell", MEMBER, AWAY, "Runs a 40-person woodworking server on a Raspberry Pi.", "Back at 3"],
      ["jun", "Jun Park", MEMBER, ONLINE, "iOS and accessibility."],
      ["lotte", "Lotte de Vries", MEMBER, OFFLINE, "Community manager in Utrecht."],
      ["sam", "Sam Okafor", MEMBER, ONLINE, "Self-hoster. Has opinions about Caddy."],
      ["theo", "Theo Grant", MEMBER, OFFLINE, "Product at a small bookshop co-op."],
      ["mei", "Mei Chen", MEMBER, AWAY, "Illustrator. Draws the community icons sometimes."],
      ["dmitri", "Dmitri Volkov", MEMBER, OFFLINE, "Rust, synths, bad puns."],
      ["fizz", "Fizz", MEMBER, ONLINE, "Posts release notes and status updates. Run by the Sblurp team.", "", true],
    ],
    channels: [
      ["Start here", "welcome", "Read this first. Then say hi in #general."],
      ["Start here", "announcements", "Release notes and news from the Sblurp team"],
      ["Talk", "general", "Anything about Sblurp, or anything at all"],
      ["Talk", "design", "Critique, screenshots and type nerdery"],
      ["Talk", "show-and-tell", "Things you made with or for Sblurp"],
      ["Talk", "help", "Stuck? Ask here. No question is too small."],
      ["Building", "self-hosting", "Running your own community server"],
      ["Building", "ideas-box", "One idea per message. React to vote."],
    ],
    dms: [["ana"], ["jun"], ["priya", "marcus"]],
    unread: { general: 3, design: 2, help: 1 },
    messages: {
      welcome: [
        [9 * D, "ian", "Welcome to the Sblurp Community. This is where people who run and use Sblurp hang out.\n\nA few things:\n> Be kind. Assume good intent.\n> Ask in #help, share in #show-and-tell.\n> Your profile is only shared with a community when you say so."],
        [9 * D - 2, "ana", "If you want a channel that doesn't exist yet, post it in #ideas-box ✨", { react: { "👍": ["priya", "jun", "sam"] } }],
      ],
      announcements: [
        [2 * D, "fizz", "**Sblurp 0.7 is out.** Threads now open in a side pane, reactions are faster, and the rail remembers your order.\n\nFull notes: https://sblurp.chat/changelog", { react: { "🎉": ["ana", "jun", "sam", "marcus", "mei"], "🥤": ["priya"] } }],
        [5 * H, "fizz", "Scheduled maintenance for sblurp.chat sign-in on Saturday at 09:00 UTC. Community servers are not affected; you stay signed in."],
      ],
      general: [
        [D + 3 * H, "marcus", "Moved our woodworking server off Discord last weekend. 41 people, one Pi 4, zero complaints so far."],
        [D + 3 * H - 1, "marcus", "The SQLite file is 18 MB after three years of history. I keep checking it's not broken."],
        [D + 3 * H - 3, "priya", "That's about right. Text is tiny. Attachments are the thing that grows.", { react: { "💯": ["sam", "marcus"] } }],
        [D + 2 * H, "sam", "Anyone running it behind Caddy with a subpath? I'd like `example.org/chat` instead of a subdomain.", {
          replies: [
            [D + 2 * H - 4, "priya", "Should work. Set `-base-url https://example.org/chat` so tokens get the right audience."],
            [D + 2 * H - 9, "sam", "That was it. I had the base URL without the path and every token was rejected."],
            [D + 2 * H - 10, "priya", "I'll add a clearer error for that. \"Token audience does not match this server\" at least."],
          ],
        }],
        [D + 50, "jun", "VoiceOver pass on the message list is done. Day dividers now announce as headings, which makes jumping around much faster."],
        [D + 48, "ana", "This is great @jun. Can you write up what you changed for #design?", { react: { "🙏": ["jun"] } }],
        [6 * H, "lotte", "Morning! Is there a way to see who reacted with what? Hovering on mobile is… not a thing."],
        [6 * H - 2, "jun", "Long-press the reaction. It lists everyone."],
        [6 * H - 3, "lotte", "Oh. That's nice. Thank you!"],
        [3 * H, "theo", "Question for the room: our co-op wants a read-only #announcements for members and a private channel for the board. Is that two servers or one?", {
          replies: [
            [3 * H - 5, "ana", "One server. Make the board channel private and invite the board."],
            [3 * H - 7, "theo", "Perfect, thanks."],
          ],
        }],
        [2 * H + 10, "mei", "Drew a new icon for the pottery folks. Feedback welcome before I send it.", { image: ["pottery-icon.svg", "image/svg+xml", 640, 400], react: { "😍": ["ana", "lotte", "ian"], "🏺": ["marcus"] } }],
        [2 * H, "dmitri", "Sblurp: the sound you make when the bug report says \"it doesn't work\" and nothing else."],
        [70, "ana", "Reminder: design crit is in 20 minutes in #design. Bring something unfinished."],
        [24, "priya", "Server 0.7.2 is tagged. Fixes the resume gap after a long sleep. Thanks @sam for the logs.", { file: ["sblurp-server-0.7.2-checksums.txt", "text/plain", 1824] }],
        [12, "sam", "Upgraded. Laptop slept for 9 hours, woke up, caught up instantly. 🥤"],
        [4, "jun", "@ian did the new composer land on staging? I want to test the mention picker with VoiceOver."],
        [3, "ana", "Also curious. The `:` emoji autocomplete felt slightly slow yesterday."],
      ],
      design: [
        [2 * D, "ana", "Proposal: avatars are rounded squares, not circles. It separates people from communities, which are circles in the rail until you hover.", {
          react: { "👍": ["ian", "mei", "jun"] },
          replies: [
            [2 * D - 10, "mei", "Yes. 8px radius at 36px reads as \"friendly but not bubbly\"."],
            [2 * D - 12, "ian", "Agreed. Shipping it."],
          ],
        }],
        [D + 4 * H, "mei", "Dark theme pass. I pushed the message area to `#1D1F2D` so the sidebar can sit one step darker.", { image: ["dark-theme.svg", "image/svg+xml", 800, 500] }],
        [D + 4 * H - 1, "ana", "Much calmer. The raspberry focus ring still pops."],
        [40, "jun", "Writeup on the VoiceOver changes:\n1. Day dividers are `role=\"heading\"` level 2\n2. Each message has an accessible name: author, time, text\n3. Reactions announce the count and whether you reacted"],
        [30, "ana", "This is **exactly** what I wanted. Pinning it in my head forever."],
        [28, "mei", "~~Can we~~ We should add this to the design doc."],
      ],
      "show-and-tell": [
        [3 * D, "marcus", "Made a bot that posts the shop's humidity every morning. Wood moves. Now we know when.", { react: { "🪵": ["sam", "dmitri"], "😂": ["priya"] } }],
        [2 * D + 5 * H, "dmitri", "A tiny CLI that tails a channel in your terminal:\n```sh\nsblurp-tail --server https://community.sblurp.chat --channel general\n```\nUses a bot token, reads the Subscribe stream, prints lines."],
      ],
      help: [
        [5 * H, "lotte", "I added a community and now it says \"Can't reach this community\". The URL works in my browser."],
        [5 * H - 4, "sam", "Is the server behind something that strips streaming responses? Some proxies buffer them."],
        [90, "lotte", "It was Cloudflare's buffering. Turned it off for that path and it connects now. Thanks Sam!"],
      ],
      "self-hosting": [
        [4 * D, "sam", "My setup: Hetzner CX22, Caddy, one systemd unit, backups with `sqlite3 .backup` to object storage every hour."],
        [4 * D - 3, "priya", "That's the recommended shape. Add `-data /var/lib/sblurp` so upgrades don't touch it."],
      ],
      "ideas-box": [],
      "dm:ana": [
        [D + 6 * H, "ana", "Do you have ten minutes later to look at the sidebar spacing?"],
        [D + 6 * H - 30, "ian", "Yes. After lunch?"],
        [D + 6 * H - 31, "ana", "👍"],
        [8, "ana", "The new rail pill looks great btw. Way better than the dot-only version."],
      ],
      "dm:jun": [
        [3 * D, "jun", "Sent you the TestFlight notes."],
        [3 * D - 20, "ian", "Got them, thanks."],
      ],
      "dm:priya,marcus": [
        [2 * D, "priya", "Marcus, can we use your Pi server as a test bed for the 0.7 migration?"],
        [2 * D - 10, "marcus", "Sure, it's backed up. Go wild."],
      ],
    },
    chatter: [
      ["general", "sam", "Small thing I love: the composer keeps my draft when I switch channels."],
      ["general", "priya", "Running the integration suite against 0.7.2 now."],
      ["general", "lotte", "Is anyone else at the meetup in Utrecht on Friday?"],
      ["design", "mei", "Trying a slightly warmer graphite for timestamps. Thoughts?"],
      ["general", "theo", "Board channel is set up. Took two minutes."],
      ["help", "dmitri", "How do I rotate a bot token without downtime?"],
      ["general", "jun", "Found a contrast issue on mention pills in dark mode. Filing it."],
      ["design", "ana", "Crit starts now. First up: the empty states."],
    ],
  },
  {
    url: "https://nightowls.chat",
    name: "Night Owls",
    description: "For people who do their best thinking after midnight. Astronomy, lo-fi, night shifts and 3 a.m. ideas.",
    accent: "#7B5CE6",
    icon: "/fake/owls.svg",
    joined: true,
    members: [
      ["rosa", "Rosa Delgado", OWNER, ONLINE, "Night nurse. Owl in human form."],
      ["ian", "Ian Langworth", MEMBER, ONLINE, "Making Sblurp."],
      ["kenji", "Kenji Watanabe", MODERATOR, ONLINE, "Amateur astronomer. 8-inch Dobsonian.", "Waiting for clouds to clear"],
      ["wren", "Wren Halloway", MEMBER, ONLINE, "Writes fiction between 1 and 4 a.m."],
      ["felix", "Felix Brandt", MEMBER, AWAY, "Bakery shift starts at 3."],
      ["nadia", "Nadia Haddad", MEMBER, OFFLINE, "Radio host, overnight slot."],
      ["oskar", "Oskar Lind", MEMBER, OFFLINE, "Lives in Tromsø. It's dark a lot."],
      ["moonbot", "Moonbot", MEMBER, ONLINE, "Posts the moon phase at midnight UTC.", "", true],
    ],
    channels: [
      ["", "lobby", "Come in, the kettle's on"],
      ["", "3am-thoughts", "Ideas that seemed brilliant at the time"],
      ["", "night-sky", "What's up there tonight"],
      ["", "lofi-radio", "Share what you're listening to"],
      ["Shift workers", "night-shift", "For everyone clocked in while the world sleeps"],
    ],
    dms: [["wren"]],
    unread: { lobby: 2, "night-sky": 4 },
    messages: {
      lobby: [
        [D + 2 * H, "rosa", "Quiet night on the ward. Tea number three."],
        [D + 2 * H - 5, "felix", "Croissants are proofing. 40 minutes of nothing to do."],
        [50, "wren", "Finished a chapter. It's 2 a.m. and I feel like I won something."],
        [20, "kenji", "@ian you said you'd join for the Perseids next year. I'm holding you to it.", { react: { "🌠": ["rosa", "wren"] } }],
        [6, "rosa", "Welcome to the three people who joined tonight 🦉"],
      ],
      "3am-thoughts": [
        [2 * D, "wren", "What if libraries had a night window, like pharmacies?", { react: { "💡": ["rosa", "felix", "oskar"] } }],
      ],
      "night-sky": [
        [D, "kenji", "Saturn tonight, low in the southeast after 10 p.m. Rings are tilting toward edge-on this year, so look while you can."],
        [D - 30, "oskar", "Aurora here. Faint green, mostly to the north.", { image: ["aurora.svg", "image/svg+xml", 900, 520], react: { "😮": ["kenji", "rosa", "wren", "ian"] } }],
        [45, "kenji", "Clouds. Of course."],
        [44, "kenji", "Waiting it out. Forecast says clear by 1."],
        [15, "moonbot", "🌔 Waxing gibbous, 87% illuminated. Moonrise 15:42, moonset 03:18."],
        [2, "kenji", "Clear! Andromeda is visible to the naked eye from the dark site."],
      ],
      "lofi-radio": [[3 * H, "nadia", "Tonight's overnight playlist is up. Mostly rain sounds and Japanese city pop."]],
      "night-shift": [[4 * H, "felix", "Anyone else find 4 a.m. the hardest hour? Not 3. 4."]],
      "dm:wren": [[2 * D, "wren", "Thanks for the Sblurp invite. This place is lovely."]],
    },
    chatter: [
      ["lobby", "felix", "First batch out of the oven. The whole street smells like butter."],
      ["night-sky", "kenji", "Just saw a bright meteor heading west. Anyone else?"],
      ["3am-thoughts", "wren", "Socks are just shoes for your shoes."],
      ["lobby", "rosa", "Handover in two hours. Then sleep."],
    ],
  },
  {
    url: "https://pottery.thursdays.club",
    name: "Pottery Thursdays",
    description: "A small studio group. Thursdays at 7, Lindengracht 41.",
    accent: "#D9822B",
    icon: "",
    joined: true,
    members: [
      ["bea", "Bea Lindqvist", OWNER, ONLINE, "Runs the studio. Fires the kiln."],
      ["ian", "Ian Langworth", MEMBER, ONLINE, "Mostly makes mugs. Some of them hold liquid."],
      ["tomas", "Tomás Herrera", MEMBER, AWAY, "Wheel-thrown everything."],
      ["hana", "Hana Novak", MEMBER, OFFLINE, "Glaze chemistry."],
      ["olu", "Olu Adeyemi", MEMBER, OFFLINE, "Hand-building and slab work."],
    ],
    channels: [
      ["", "studio", "Thursdays at 7"],
      ["", "glaze-lab", "Recipes, tests and happy accidents"],
      ["", "kiln-schedule", "Bisque Mondays, glaze Wednesdays"],
    ],
    dms: [],
    unread: { "glaze-lab": 1 },
    messages: {
      studio: [
        [7 * D, "bea", "Clay order arrives Wednesday. 10 bags of stoneware, 4 of porcelain."],
        [2 * D, "tomas", "Can someone save me a wheel? I'll be 15 minutes late."],
        [2 * D - 3, "bea", "Saved the one by the window."],
      ],
      "glaze-lab": [
        [D, "hana", "Test tiles from the celadon batch. Left one is cone 6, right is cone 10.", { image: ["glaze-tiles.svg", "image/svg+xml", 720, 480], react: { "🤩": ["bea", "ian"] } }],
        [D - 6, "hana", "Recipe, for anyone who wants it:\n```\nCustom celadon, cone 6\nNepheline syenite  30\nSilica             25\nWhiting            20\nEPK kaolin         15\nFrit 3134          10\n+ red iron oxide    1\n```"],
        [35, "olu", "Mine came out the colour of weak tea. Did I apply it too thin?"],
      ],
      "kiln-schedule": [[3 * D, "bea", "Glaze firing Wednesday. Shelves loaded by Tuesday 9 p.m. please."]],
    },
    chatter: [
      ["studio", "tomas", "Left my trimming tools by the sink, sorry!"],
      ["glaze-lab", "hana", "Olu, three dips next time. Thin celadon goes brown."],
    ],
  },
  {
    url: "https://letterpress.club",
    name: "Letterpress Club",
    description: "Lead type, ink and the people who love them.",
    accent: "#0F9D8A",
    icon: "",
    joined: false,
    members: [["gus", "Gus Fairweather", OWNER, ONLINE, "Prints posters on a 1921 Vandercook."]],
    channels: [["", "pressroom", "Show your prints"]],
    dms: [],
    unread: {},
    messages: { pressroom: [[D, "gus", "Welcome, printers."]] },
    chatter: [],
  },
];

interface Fake {
  info: GetServerInfoResponse;
  joined: boolean;
  meId: string;
  members: Map<string, Member>;
  channels: Map<string, Channel>;
  messages: Message[];
  reads: Map<string, ReadState>;
  seq: bigint;
  log: Event[];
  logStart: bigint;
  subs: Set<(e: Event) => void>;
  uploads: Map<string, Attachment>;
  chatter: Seed["chatter"];
}

let nextId = 1;
const id = (p: string) => `${p}${(nextId++).toString(36).padStart(5, "0")}`;

function seed(s: Seed, now: number): Fake {
  const f: Fake = {
    info: create(GetServerInfoResponseSchema, {
      name: s.name,
      description: s.description,
      iconUrl: s.icon,
      protocolVersion: 1,
      trustedIssuers: ["https://sblurp.chat"],
      baseUrl: s.url,
      memberCount: s.members.length,
      accentColor: s.accent,
    }),
    joined: s.joined,
    meId: "",
    members: new Map(),
    channels: new Map(),
    messages: [],
    reads: new Map(),
    seq: 0n,
    log: [],
    logStart: 0n,
    subs: new Set(),
    uploads: new Map(),
    chatter: s.chatter,
  };
  const byName = new Map<string, Member>();
  for (const [username, displayName, role, presence, bio, statusText = "", bot] of s.members) {
    const m = create(MemberSchema, {
      id: id("m"),
      kind: bot ? MemberKind.BOT : MemberKind.HUMAN,
      role,
      username,
      displayName,
      bio,
      presence,
      statusText,
      joinedAtMs: BigInt(now - 30 * D * 60_000),
    });
    if (username === "ian") {
      f.meId = m.id;
      if (!s.joined) continue;
    }
    f.members.set(m.id, m);
    byName.set(username, m);
  }
  if (!f.meId) f.meId = id("m");
  const all = [...f.members.values()];
  const chanByKey = new Map<string, Channel>();
  s.channels.forEach(([category, name, topic], i) => {
    const ch = create(ChannelSchema, { id: id("c"), kind: ChannelKind.TEXT, name, topic, category, position: i });
    f.channels.set(ch.id, ch);
    chanByKey.set(name, ch);
  });
  for (const names of s.dms) {
    const ch = create(ChannelSchema, {
      id: id("d"),
      kind: ChannelKind.DM,
      memberIds: [f.meId, ...names.map((n) => byName.get(n)!.id)],
    });
    f.channels.set(ch.id, ch);
    chanByKey.set(`dm:${names.join(",")}`, ch);
  }
  // Build every message, then assign seqs in time order.
  type Pending = { m: Message; key: string };
  const out: Pending[] = [];
  const at = (mins: number) => BigInt(now - mins * 60_000);
  for (const [key, lines] of Object.entries(s.messages)) {
    const ch = chanByKey.get(key)!;
    for (const [mins, user, text, x = {}] of lines) {
      const m = create(MessageSchema, {
        id: id("x"),
        channelId: ch.id,
        authorId: byName.get(user)!.id,
        text: encodeMentions(text, all),
        createdAtMs: at(mins),
        editedAtMs: x.edited ? at(mins - 1) : 0n,
        reactions: Object.entries(x.react ?? {}).map(([emoji, users]) => ({ emoji, memberIds: users.map((u) => byName.get(u)?.id ?? f.meId) })),
      });
      if (x.image) {
        const [name, contentType, width, height] = x.image;
        m.attachments.push(create(AttachmentSchema, { id: id("a"), name, contentType, width, height, size: 48_213n, url: `/fake/${name}` }));
      }
      if (x.file) {
        const [name, contentType, size] = x.file;
        m.attachments.push(create(AttachmentSchema, { id: id("a"), name, contentType, size: BigInt(size), url: `/fake/${name}` }));
      }
      out.push({ m, key });
      for (const [rmins, ruser, rtext] of x.replies ?? []) {
        out.push({
          m: create(MessageSchema, {
            id: id("x"),
            channelId: ch.id,
            authorId: byName.get(ruser)!.id,
            text: encodeMentions(rtext, all),
            createdAtMs: at(rmins),
            threadRootId: m.id,
          }),
          key,
        });
        m.replyCount++;
        m.lastReplyAtMs = at(rmins);
      }
    }
  }
  out.sort((a, b) => Number(a.m.createdAtMs - b.m.createdAtMs));
  for (const { m } of out) {
    m.seq = ++f.seq;
    f.messages.push(m);
    if (!m.threadRootId) f.channels.get(m.channelId)!.lastMessageSeq = m.seq;
  }
  for (const ch of f.channels.values()) {
    const key = [...chanByKey].find(([, c]) => c === ch)![0];
    const roots = f.messages.filter((m) => m.channelId === ch.id && !m.threadRootId);
    const n = s.unread[key] ?? 0;
    const unread = n ? roots.slice(-n) : [];
    const lastRead = roots.length > n ? roots[roots.length - n - 1].seq : 0n;
    f.reads.set(
      ch.id,
      create(ReadStateSchema, {
        channelId: ch.id,
        lastReadSeq: lastRead,
        unreadCount: unread.length,
        mentionCount: unread.filter((m) => ch.kind === ChannelKind.DM || mentionsMe(m.text, f.meId)).length,
      }),
    );
  }
  f.logStart = f.seq;
  return f;
}

function emit(f: Fake, kind: Event["kind"], ephemeral = false): Event {
  const ev = create(EventSchema, { atMs: BigInt(Date.now()), kind });
  if (!ephemeral) {
    ev.seq = ++f.seq;
    if (kind.case?.startsWith("message")) (kind.value as Message).seq = ev.seq;
    f.log.push(ev);
  }
  for (const s of f.subs) s(ev);
  return ev;
}

function canSee(f: Fake, ch: Channel | undefined) {
  return !!ch && (ch.kind === ChannelKind.TEXT || ch.memberIds.includes(f.meId));
}

function post(f: Fake, channelId: string, authorId: string, text: string, threadRootId = "", clientId = "", attachments: Attachment[] = []) {
  const m = create(MessageSchema, {
    id: id("x"),
    channelId,
    authorId,
    text,
    threadRootId,
    clientId,
    attachments,
    createdAtMs: BigInt(Date.now()),
  });
  f.messages.push(m);
  emit(f, { case: "messageCreated", value: m });
  if (threadRootId) {
    const root = f.messages.find((x) => x.id === threadRootId)!;
    root.replyCount++;
    root.lastReplyAtMs = m.createdAtMs;
    emit(f, { case: "messageUpdated", value: root });
  } else {
    f.channels.get(channelId)!.lastMessageSeq = m.seq;
  }
  return m;
}

function service(f: Fake) {
  const me = () => f.members.get(f.meId)!;
  const need = () => {
    if (!f.joined) throw new ConnectError("join this community first", Code.PermissionDenied);
  };
  const msg = (messageId: string) => {
    const m = f.messages.find((x) => x.id === messageId);
    if (!m || m.deleted) throw new ConnectError("message not found", Code.NotFound);
    return m;
  };
  const mine = (m: Message) => {
    if (m.authorId !== f.meId) throw new ConnectError("not your message", Code.PermissionDenied);
  };
  return {
    server: {
      getServerInfo: () => f.info,
      join(req: { displayName: string; avatarUrl: string; bio: string }) {
        const created = !f.joined;
        if (created) {
          f.joined = true;
          const m = create(MemberSchema, {
            id: f.meId,
            kind: MemberKind.HUMAN,
            role: MEMBER,
            username: "ian",
            displayName: req.displayName || "ian",
            avatarUrl: req.avatarUrl,
            bio: req.bio,
            presence: ONLINE,
            joinedAtMs: BigInt(Date.now()),
          });
          f.members.set(m.id, m);
          f.info.memberCount++;
          emit(f, { case: "memberJoined", value: m });
        }
        return { member: me(), created };
      },
      getMe() {
        need();
        return { member: me() };
      },
      updateProfile(req: Partial<Member>) {
        need();
        const m = me();
        for (const k of ["displayName", "avatarUrl", "bio", "statusText", "statusEmoji"] as const) {
          if (req[k] !== undefined) m[k] = req[k]!;
        }
        emit(f, { case: "memberUpdated", value: m });
        return { member: m };
      },
      getState() {
        need();
        return {
          me: me(),
          channels: [...f.channels.values()].filter((c) => canSee(f, c)),
          members: [...f.members.values()],
          readStates: [...f.reads.values()].filter((r) => canSee(f, f.channels.get(r.channelId))),
          seq: f.seq,
        };
      },
      async *subscribe(req: { afterSeq: bigint }, ctx: { signal: AbortSignal }) {
        need();
        const queue: Event[] = [];
        let wake: (() => void) | null = null;
        const push = (e: Event) => {
          queue.push(e);
          wake?.();
        };
        f.subs.add(push);
        ctx.signal.addEventListener("abort", () => wake?.());
        try {
          if (req.afterSeq < f.logStart) {
            yield create(EventSchema, { kind: { case: "resync", value: true } });
            return;
          }
          for (const e of f.log) if (e.seq > req.afterSeq) yield e;
          while (!ctx.signal.aborted) {
            if (!queue.length) {
              await new Promise<void>((r) => {
                wake = r;
                setTimeout(r, 25_000);
              });
              wake = null;
            }
            if (ctx.signal.aborted) return;
            yield queue.shift() ?? create(EventSchema, { atMs: BigInt(Date.now()), kind: { case: "heartbeat", value: true } });
          }
        } finally {
          f.subs.delete(push);
        }
      },
    },
    chat: {
      createChannel(req: { name: string; kind: ChannelKind; topic: string; category: string }) {
        need();
        const ch = create(ChannelSchema, { ...req, id: id("c"), createdAtMs: BigInt(Date.now()) });
        f.channels.set(ch.id, ch);
        emit(f, { case: "channelCreated", value: ch });
        return { channel: ch };
      },
      updateChannel(req: { channelId: string; name?: string; topic?: string; category?: string; position?: number }) {
        need();
        const ch = f.channels.get(req.channelId);
        if (!ch) throw new ConnectError("channel not found", Code.NotFound);
        for (const k of ["name", "topic", "category", "position"] as const) {
          if (req[k] !== undefined) (ch as Record<string, unknown>)[k] = req[k];
        }
        emit(f, { case: "channelUpdated", value: ch });
        return { channel: ch };
      },
      openDM(req: { memberIds: string[] }) {
        need();
        const want = [...new Set([f.meId, ...req.memberIds])].sort().join();
        let ch = [...f.channels.values()].find((c) => c.kind === ChannelKind.DM && [...c.memberIds].sort().join() === want);
        if (!ch) {
          ch = create(ChannelSchema, { id: id("d"), kind: ChannelKind.DM, memberIds: want.split(","), createdAtMs: BigInt(Date.now()) });
          f.channels.set(ch.id, ch);
          emit(f, { case: "channelCreated", value: ch });
        }
        return { channel: ch };
      },
      listMessages(req: { channelId: string; threadRootId: string; beforeId: string; limit: number }) {
        need();
        if (!canSee(f, f.channels.get(req.channelId))) throw new ConnectError("channel not found", Code.NotFound);
        let list = f.messages.filter((m) =>
          req.threadRootId ? m.threadRootId === req.threadRootId : m.channelId === req.channelId && !m.threadRootId,
        );
        list = list.filter((m) => !m.deleted || m.replyCount > 0);
        if (req.beforeId) list = list.slice(0, Math.max(0, list.findIndex((m) => m.id === req.beforeId)));
        const limit = Math.min(req.limit || 50, 200);
        return { messages: list.slice(-limit), hasMore: list.length > limit };
      },
      sendMessage(req: { channelId: string; text: string; threadRootId: string; clientId: string; attachmentIds: string[] }) {
        need();
        if (!canSee(f, f.channels.get(req.channelId))) throw new ConnectError("channel not found", Code.NotFound);
        if (!req.text.trim() && !req.attachmentIds.length) throw new ConnectError("message is empty", Code.InvalidArgument);
        const dup = req.clientId && f.messages.find((m) => m.clientId === req.clientId);
        if (dup) return { message: dup };
        const atts = req.attachmentIds.map((a) => f.uploads.get(a)).filter((a): a is Attachment => !!a);
        const m = post(f, req.channelId, f.meId, req.text, req.threadRootId, req.clientId, atts);
        f.reads.set(req.channelId, create(ReadStateSchema, { channelId: req.channelId, lastReadSeq: m.seq }));
        return { message: m };
      },
      editMessage(req: { messageId: string; text: string }) {
        need();
        const m = msg(req.messageId);
        mine(m);
        m.text = req.text;
        m.editedAtMs = BigInt(Date.now());
        emit(f, { case: "messageUpdated", value: m });
        return { message: m };
      },
      deleteMessage(req: { messageId: string }) {
        need();
        const m = msg(req.messageId);
        mine(m);
        m.deleted = true;
        m.text = "";
        m.attachments = [];
        emit(f, { case: "messageDeleted", value: m });
        return {};
      },
      react(req: { messageId: string; emoji: string; remove: boolean }) {
        need();
        const m = msg(req.messageId);
        let r = m.reactions.find((x) => x.emoji === req.emoji);
        if (!r && !req.remove) m.reactions.push((r = { emoji: req.emoji, memberIds: [] } as never));
        if (r) {
          r.memberIds = r.memberIds.filter((x) => x !== f.meId);
          if (!req.remove) r.memberIds.push(f.meId);
          if (!r.memberIds.length) m.reactions = m.reactions.filter((x) => x !== r);
        }
        emit(f, { case: "messageUpdated", value: m });
        return { message: m };
      },
      markRead(req: { channelId: string; seq: bigint }) {
        need();
        const rs = create(ReadStateSchema, { channelId: req.channelId, lastReadSeq: req.seq });
        f.reads.set(req.channelId, rs);
        return { readState: rs };
      },
      setTyping() {
        need();
        return {};
      },
      search(req: { query: string; channelId: string; limit: number }) {
        need();
        const q = req.query.toLowerCase();
        const hits = f.messages.filter(
          (m) =>
            !m.deleted &&
            m.text.toLowerCase().includes(q) &&
            canSee(f, f.channels.get(m.channelId)) &&
            (!req.channelId || m.channelId === req.channelId),
        );
        return { messages: hits.reverse().slice(0, req.limit || 20) };
      },
    },
    bot: {
      createBot(req: { username: string; displayName: string; avatarUrl: string; bio: string }) {
        need();
        const bot = create(MemberSchema, { ...req, id: id("m"), kind: MemberKind.BOT, role: MEMBER, presence: ONLINE });
        f.members.set(bot.id, bot);
        emit(f, { case: "memberJoined", value: bot });
        return { bot, token: `sbb_${crypto.randomUUID().replace(/-/g, "")}` };
      },
      listBots() {
        need();
        return { bots: [...f.members.values()].filter((m) => m.kind === MemberKind.BOT) };
      },
      rotateBotToken() {
        need();
        return { token: `sbb_${crypto.randomUUID().replace(/-/g, "")}` };
      },
      deleteBot(req: { botId: string }) {
        need();
        f.members.delete(req.botId);
        emit(f, { case: "memberLeft", value: req.botId });
        return {};
      },
    },
  };
}

const fakes = new Map<string, Fake>();
export const FAKE_URLS = SEEDS.filter((s) => s.joined).map((s) => s.url);

function init() {
  if (fakes.size) return;
  const now = Date.now();
  for (const s of SEEDS) fakes.set(s.url, seed(s, now));
}

/** Transport for a fake community, or null when no fake server lives at that URL. */
export function fakeTransport(url: string): Transport | null {
  init();
  const f = fakes.get(url);
  if (!f) return null;
  const s = service(f);
  return createRouterTransport((router) => {
    router.service(ServerService, s.server as never);
    router.service(ChatService, s.chat as never);
    router.service(BotService, s.bot as never);
  });
}

export async function fakeUpload(url: string, file: File): Promise<Attachment> {
  const f = fakes.get(url)!;
  let width = 0;
  let height = 0;
  if (file.type.startsWith("image/")) {
    try {
      const bmp = await createImageBitmap(file);
      width = bmp.width;
      height = bmp.height;
    } catch {
      // not decodable; shown as a file card
    }
  }
  const a = create(AttachmentSchema, {
    id: id("a"),
    name: file.name,
    contentType: file.type || "application/octet-stream",
    size: BigInt(file.size),
    url: URL.createObjectURL(file),
    width,
    height,
  });
  f.uploads.set(a.id, a);
  return a;
}

/** Someone else types for a moment and then posts. Returns false when there is nothing to say. */
export function simulateOnce(): boolean {
  init();
  const joined = [...fakes.values()].filter((f) => f.joined && f.chatter.length);
  const f = joined[Math.floor(Math.random() * joined.length)];
  if (!f) return false;
  const [chName, user, text] = f.chatter.shift()!;
  const ch = [...f.channels.values()].find((c) => c.name === chName);
  const author = [...f.members.values()].find((m) => m.username === user);
  if (!ch || !author) return false;
  const typing = () => emit(f, { case: "typing", value: { channelId: ch.id, memberId: author.id, threadRootId: "" } as never }, true);
  typing();
  setTimeout(typing, 2000);
  setTimeout(() => post(f, ch.id, author.id, text), 3500);
  return true;
}

export function startSimulation() {
  const tick = () => {
    if (simulateOnce()) setTimeout(tick, 9000 + Math.random() * 12000);
  };
  setTimeout(tick, 6000);
  // Presence drifts now and then.
  setInterval(() => {
    const f = fakes.get(FAKE_URLS[Math.floor(Math.random() * FAKE_URLS.length)])!;
    const others = [...f.members.values()].filter((m) => m.id !== f.meId && m.kind === MemberKind.HUMAN);
    const m = others[Math.floor(Math.random() * others.length)];
    m.presence = m.presence === ONLINE ? AWAY : ONLINE;
    emit(f, { case: "presence", value: { memberId: m.id, presence: m.presence } as never }, true);
  }, 20_000);
}

/** Lets scripts push a typing event deterministically. */
export function fakeTyping(url: string, channelName: string, username: string) {
  const f = fakes.get(url)!;
  const ch = [...f.channels.values()].find((c) => c.name === channelName)!;
  const m = [...f.members.values()].find((x) => x.username === username)!;
  emit(f, { case: "typing", value: { channelId: ch.id, memberId: m.id, threadRootId: "" } as never }, true);
}
