// In-memory community servers for ?fake=1: real Connect services over createRouterTransport,
// seeded with three joined communities and one to discover, plus simulated activity.
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import {
  AttachmentSchema,
  BanSchema,
  BotService,
  ChannelKind,
  ChannelMode,
  ChannelSchema,
  ChatService,
  EventSchema,
  GetServerInfoResponseSchema,
  InviteSchema,
  MemberKind,
  MemberRole,
  MemberSchema,
  MessageSchema,
  PluginSchema,
  ReportSchema,
  type Plugin,
  Presence,
  ReactionSchema,
  ReadStateSchema,
  RoleSchema,
  ServerService,
  type Attachment,
  type Ban,
  type Channel,
  type Event,
  type GetServerInfoResponse,
  type Invite,
  type Member,
  type Message,
  type ReadState,
  type Report,
  type Role,
} from "./gen/sblurp/v1/sblurp_pb";
import { videoPoster } from "./avatar";
import { BANNER_TYPES, encodeMentions, mayPost, mentionsMe, messageHash } from "./logic";

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
  invite?: string; // makes the community invite-only, with this code
  members: [username: string, name: string, role: MemberRole, presence: Presence, bio: string, status?: string, bot?: true][];
  channels: [category: string, name: string, topic: string, privateTo?: string[]][];
  dms: string[][];
  messages: Record<string, Line[]>;
  unread: Record<string, number>;
  chatter: [channel: string, user: string, text: string][];
  optIn?: { defaults: string[]; notIn: string[] }; // OPT_IN mode: default channels and the ones I have not joined
  roles?: [name: string, color: string, users: string[], gates: string[]][];
  banned?: [username: string, name: string, daysAgo: number, by: string][];
  banner?: string; // community banner image (1026)
  headers?: Record<string, string>; // channel name -> header image (1027)
  questions?: string[]; // join questions; a blank or very short answer is refused, like a plugin would
  fresh?: boolean; // needs setup (1286)
  postRoles?: Record<string, string[]>; // channel name -> Channel.post_role_ids (1308)
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
    banner: "/fake/community-banner.svg",
    headers: { help: "/fake/help-header.svg" },
    postRoles: { welcome: ["admin"], announcements: ["admin", "moderator"] },
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
      ["Talk", "help", "Stuck? Ask here. No question is too small.\nCheck the [self-hosting guide](https://sblurp.chat/docs/self-host) first, and paste `sblurp-server -version` with your question. **Be kind** to people who are new."],
      ["Building", "self-hosting", "Running your own community server"],
      ["Building", "ideas-box", "One idea per message. React to vote."],
      ["Building", "core-team", "Release dates and things not ready to share", ["ana", "priya"]],
      ["Talk", "reading-room", "What we're reading. This month: The Mythical Man-Month"],
      ["Talk", "off-topic", "Pets, food, weather and everything else"],
      ["Building", "maintainers", "Reviews and release planning for people who maintain Sblurp"],
    ],
    optIn: { defaults: ["announcements", "general", "help"], notIn: ["reading-room", "off-topic", "maintainers"] },
    roles: [
      ["Maintainers", "#3550f0", ["ian", "ana", "priya"], ["maintainers"]],
      ["Designers", "#d0306a", ["ana", "mei"], []],
      ["Helpers", "#0f8b8d", ["jun", "sam"], []],
    ],
    dms: [["ana"], ["jun"], ["priya", "marcus"]],
    banned: [["freecoins", "Free Coins Daily", 2, "ana"], ["rhea", "Rhea Stone", 40, "priya"]],
    unread: { general: 3, design: 2, help: 1 },
    messages: {
      "reading-room": [
        [3 * D, "theo", "Chapter 2 is the one everybody quotes. Adding people to a late project makes it later."],
        [3 * D - 4, "lotte", "Still true fifty years on, sadly.", { react: { "📚": ["theo", "mei"] } }],
      ],
      maintainers: [[D, "priya", "Release branch for 0.8 is cut. Reviews welcome on the sync patch."]],
      "core-team": [[2 * H, "ana", "Release notes for 0.8 are in the doc. Ship Thursday unless @priya says otherwise."]],
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
        [6 * H - 6, "marcus", "Custom emoji work now :party_blob: I dropped a whole Slackmoji folder on Settings > Emoji and it took all 140 :catjam:", { react: { ":sblurp:": ["ana", "jun", "priya"], ":lgtm:": ["sam"], ":party_blob:": ["lotte", "theo"] } }],
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
        [4 * D - 9, "sam", "And the hourly backup, if anyone wants it:\n```ts\n// Copy the live database without stopping the server.\nconst every = 60 * 60 * 1000;\nsetInterval(async () => {\n  await run(\"sqlite3\", [\"/var/lib/sblurp/chat.db\", `.backup /backups/${Date.now()}.db`]);\n}, every);\n```"],
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
    postRoles: { "kiln-schedule": ["admin"] },
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
      ["", "kiln-crew", "Loading, firing and unloading rota"],
    ],
    roles: [
      ["Glaze nerds", "#2f8f5b", ["hana", "ian"], []],
      ["Kiln crew", "#c2410c", ["bea", "tomas"], ["kiln-crew"]],
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
      "kiln-crew": [[D, "bea", "Tomás, can you unload Thursday morning?"]],
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
    invite: "INKSTAINED",
    questions: ["What press do you print on?"],
    members: [["gus", "Gus Fairweather", OWNER, ONLINE, "Prints posters on a 1921 Vandercook."]],
    channels: [["", "pressroom", "Show your prints"]],
    dms: [],
    unread: {},
    messages: { pressroom: [[D, "gus", "Welcome, printers."]] },
    chatter: [],
  },
];
// ?fake=1&setup=1: a brand-new community I own, with only #general, for the setup wizard (1286).
if (new URLSearchParams(location.search).has("setup"))
  SEEDS.push({
    url: "https://saturday.climbers.club",
    name: "Saturday Climbers",
    description: "",
    accent: "#2F8F5B",
    icon: "",
    joined: true,
    fresh: true,
    members: [["ian", "Ian Langworth", OWNER, ONLINE, ""]],
    channels: [["", "general", ""]],
    dms: [],
    unread: {},
    messages: {},
    chatter: [],
  });

interface Fake {
  info: GetServerInfoResponse;
  invites: Invite[];
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
  mode: ChannelMode;
  roles: Role[];
  notIn: Set<string>; // OPT_IN: visible text channels I have not joined
  bans: Ban[];
  plugins: Plugin[];
  blocked: Set<string>; // members I blocked (1118)
  muted: Set<string>; // members I muted (1293)
  reports: Report[]; // open reports, newest first (1119)
  hidden: Set<string>; // DMs I left; a new message brings one back
}

let nextId = 1;
const id = (p: string) => `${p}${(nextId++).toString(36).padStart(5, "0")}`;

const fakeImage = (url: string, width: number, height: number) =>
  create(AttachmentSchema, { id: id("a"), name: url.split("/").pop(), contentType: "image/svg+xml", url, width, height });

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
      inviteOnly: !!s.invite,
      joinQuestions: s.questions ?? [],
      banner: s.banner ? fakeImage(s.banner, 1200, 400) : undefined,
      needsSetup: !!s.fresh,
    }),
    invites: s.invite ? [create(InviteSchema, { code: s.invite, createdAtMs: BigInt(now - D * 60_000) })] : [],
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
    mode: s.optIn ? ChannelMode.OPT_IN : ChannelMode.ROLES,
    roles: [],
    notIn: new Set(),
    blocked: new Set(),
    muted: new Set(),
    reports: [],
    hidden: new Set(),
    bans: [],
    plugins: [
      create(PluginSchema, { name: "dice", enabled: true, running: true }),
      create(PluginSchema, { name: "greeter", enabled: false }),
      create(PluginSchema, { name: "verify", enabled: true, error: "SyntaxError: expecting ')' at verify.js:12" }),
    ],
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
  for (const [username, displayName, days, by] of s.banned ?? []) {
    const member = create(MemberSchema, { id: id("m"), kind: MemberKind.HUMAN, role: MEMBER, username, displayName, presence: OFFLINE });
    f.bans.push(create(BanSchema, { member, bannedBy: byName.get(by)!.id, bannedAtMs: BigInt(now - days * D * 60_000) }));
  }
  const all = [...f.members.values()];
  const chanByKey = new Map<string, Channel>();
  s.channels.forEach(([category, name, topic, privateTo], i) => {
    const ch = create(ChannelSchema, {
      id: id("c"),
      kind: privateTo ? ChannelKind.PRIVATE : ChannelKind.TEXT,
      name,
      topic,
      category,
      position: i,
      memberIds: privateTo ? [f.meId, ...privateTo.map((n) => byName.get(n)!.id)] : [],
    });
    if (s.headers?.[name]) ch.headerImage = fakeImage(s.headers[name], 1600, 200);
    ch.postRoleIds = s.postRoles?.[name] ?? [];
    f.channels.set(ch.id, ch);
    chanByKey.set(name, ch);
  });
  s.roles?.forEach(([name, color, users, gates], position) => {
    const r = create(RoleSchema, { id: id("r"), name, color, position });
    f.roles.push(r);
    for (const u of users) (u === "ian" ? (f.members.get(f.meId) ?? null) : byName.get(u))?.roleIds.push(r.id);
    for (const g of gates) chanByKey.get(g)!.roleIds.push(r.id);
  });
  for (const n of s.optIn?.defaults ?? []) chanByKey.get(n)!.isDefault = true;
  for (const n of s.optIn?.notIn ?? []) f.notIn.add(chanByKey.get(n)!.id);
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
  // Performance runs: ?fake=1&big=5000 adds that many older messages to #show-and-tell.
  const big = Math.min(Number(new URLSearchParams(location.search).get("big")) || 0, 50_000);
  const filler = chanByKey.get("show-and-tell");
  const people = [...byName.values()];
  for (let i = 0; big && filler && i < big; i++) {
    const text = `Message ${i + 1}. ${i % 7 ? "Kiln log for batch" : "**Bold** note with `code` about batch"} ${i % 97}, cone ${6 + (i % 5)}.`;
    out.push({ m: create(MessageSchema, { id: id("x"), channelId: filler.id, authorId: people[i % people.length].id, text, createdAtMs: at(20 * D + (big - i) * 7) }), key: "show-and-tell" });
  }
  out.sort((a, b) => Number(a.m.createdAtMs - b.m.createdAtMs));
  for (const { m } of out) {
    m.seq = m.createdSeq = ++f.seq;
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
  // One open report for the moderator queue: someone else's message, reported by a third member.
  const target = f.messages.find((m) => m.authorId !== f.meId && !m.threadRootId && f.channels.get(m.channelId)?.kind === ChannelKind.TEXT && m.text);
  const reporter = all.find((m) => m.id !== f.meId && m.id !== target?.authorId && m.kind === MemberKind.HUMAN);
  if (target && reporter)
    f.reports.push(
      create(ReportSchema, {
        id: id("r"),
        message: create(MessageSchema, { id: target.id, channelId: target.channelId, authorId: target.authorId, text: target.text, createdAtMs: target.createdAtMs }),
        author: f.members.get(target.authorId),
        reporter,
        note: "This keeps happening in this channel. Please take a look.",
        reportedAtMs: BigInt(now - 40 * 60_000),
      }),
    );
  f.logStart = f.seq;
  return f;
}

function emit(f: Fake, kind: Event["kind"], ephemeral = false): Event {
  const ev = create(EventSchema, { atMs: BigInt(Date.now()), kind });
  if (!ephemeral) {
    ev.seq = ++f.seq;
    if (kind.case?.startsWith("message")) (kind.value as Message).seq = ev.seq;
    if (kind.case === "messageCreated") kind.value.createdSeq = ev.seq;
    f.log.push(ev);
  }
  if (delivered(f, ev)) for (const s of f.subs) s(ev);
  return ev;
}

/** Whether I may see a channel at all: preview, browse and read it. */
function canSee(f: Fake, ch: Channel | undefined) {
  if (!ch) return false;
  if (ch.kind !== ChannelKind.TEXT) return ch.memberIds.includes(f.meId);
  const me = f.members.get(f.meId);
  return !ch.roleIds.length || (!!me && (me.role >= MemberRole.ADMIN || ch.roleIds.some((r) => me.roleIds.includes(r))));
}
/** Whether a channel is in my sidebar: visible and, in OPT_IN, joined. */
function inside(f: Fake, ch: Channel | undefined) {
  return canSee(f, ch) && !f.hidden.has(ch!.id) && !(ch!.kind === ChannelKind.TEXT && f.mode === ChannelMode.OPT_IN && f.notIn.has(ch!.id));
}
/** Like the real server (1124): a channel I can see but have not joined (OPT_IN) is read-only. */
function mustBeIn(f: Fake, id: string) {
  const ch = f.channels.get(id);
  if (!canSee(f, ch)) throw new ConnectError("channel not found", Code.NotFound);
  if (ch!.kind === ChannelKind.TEXT && f.mode === ChannelMode.OPT_IN && f.notIn.has(id)) throw new ConnectError(`join #${ch!.name} first`, Code.FailedPrecondition);
}
/** Events about channels outside my sidebar never reach me, like on the real server. */
function delivered(f: Fake, e: Event) {
  const k = e.kind;
  const chId = k.case?.startsWith("message") ? (k.value as Message).channelId : k.case === "typing" ? k.value.channelId : "";
  return !chId || inside(f, f.channels.get(chId));
}

/** Like the real server: no DMs between me and someone I blocked. */
function checkBlocks(f: Fake, dmMembers: string[]) {
  if (dmMembers.some((m) => f.blocked.has(m)))
    throw new ConnectError("you cannot message this member: one of you blocked the other", Code.PermissionDenied);
}

/** A hidden DM comes back on a new message or OpenDM. */
function unhide(f: Fake, ch: Channel) {
  if (f.hidden.delete(ch.id)) emit(f, { case: "channelUpdated", value: ch });
}

function post(f: Fake, channelId: string, authorId: string, text: string, threadRootId = "", clientId = "", attachments: Attachment[] = []) {
  unhide(f, f.channels.get(channelId)!);
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
  const admin = () => {
    need();
    if (me().role < MemberRole.ADMIN) throw new ConnectError("admins only", Code.PermissionDenied);
  };
  // Like the server: the caller's own image upload.
  const image = (id: string) => {
    const a = f.uploads.get(id);
    if (!a || !BANNER_TYPES.includes(a.contentType)) throw new ConnectError("upload the image first", Code.InvalidArgument);
    return a;
  };
  const mod = () => {
    need();
    if (me().role < MemberRole.MODERATOR) throw new ConnectError("moderators and up only", Code.PermissionDenied);
  };
  const remove = (memberId: string, ban: boolean) => {
    mod();
    const m = f.members.get(memberId);
    if (!m || m.kind !== MemberKind.HUMAN) throw new ConnectError("member not found", Code.NotFound);
    if (m.role >= me().role) throw new ConnectError("you can only remove members of a lower role", Code.PermissionDenied);
    f.members.delete(memberId);
    f.info.memberCount--;
    if (ban) f.bans.unshift(create(BanSchema, { member: m, bannedBy: f.meId, bannedAtMs: BigInt(Date.now()) }));
    emit(f, { case: "memberLeft", value: memberId });
    return {};
  };
  const mine = (m: Message) => {
    if (m.authorId !== f.meId) throw new ConnectError("not your message", Code.PermissionDenied);
  };
  return {
    server: {
      getServerInfo: () => f.info,
      join(req: { displayName: string; avatarUrl: string; bio: string; inviteCode: string; answers: string[] }) {
        const created = !f.joined;
        const inv = f.invites.find((i) => i.code === req.inviteCode.trim().toUpperCase());
        if (created && f.info.inviteOnly) {
          if (!inv || (inv.expiresAtMs && inv.expiresAtMs < BigInt(Date.now())) || (inv.maxUses && inv.uses >= inv.maxUses))
            throw new ConnectError("this community needs a valid invite code", Code.PermissionDenied);
          inv.uses++;
        }
        if (created && f.info.joinQuestions.some((_, i) => (req.answers[i] ?? "").trim().length < 3))
          throw new ConnectError("tell us a little about your press so we know you print", Code.PermissionDenied);
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
      blockMember(req: { memberId: string }) {
        need();
        if (!f.blocked.has(req.memberId)) (f.blocked.add(req.memberId), emit(f, { case: "memberBlocked", value: req.memberId }));
        return {};
      },
      unblockMember(req: { memberId: string }) {
        need();
        if (f.blocked.delete(req.memberId)) emit(f, { case: "memberUnblocked", value: req.memberId });
        return {};
      },
      muteMember(req: { memberId: string }) {
        need();
        if (!f.muted.has(req.memberId)) (f.muted.add(req.memberId), emit(f, { case: "memberMuted", value: req.memberId }));
        return {};
      },
      unmuteMember(req: { memberId: string }) {
        need();
        if (f.muted.delete(req.memberId)) emit(f, { case: "memberUnmuted", value: req.memberId });
        return {};
      },
      leaveCommunity() {
        need();
        if (me().role === MemberRole.OWNER) throw new ConnectError("the owner cannot leave", Code.FailedPrecondition);
        f.joined = false;
        f.members.delete(f.meId);
        f.info.memberCount--;
        return {};
      },
      kickMember(req: { memberId: string }) {
        return remove(req.memberId, false);
      },
      banMember(req: { memberId: string }) {
        return remove(req.memberId, true);
      },
      listBans() {
        mod();
        return { bans: f.bans };
      },
      unbanMember(req: { memberId: string }) {
        mod();
        if (!f.bans.some((b) => b.member?.id === req.memberId)) throw new ConnectError("that member is not banned", Code.NotFound);
        f.bans = f.bans.filter((b) => b.member?.id !== req.memberId);
        return {};
      },
      reportMessage(req: { messageId: string; note: string }) {
        need();
        const m = f.messages.find((x) => x.id === req.messageId && !x.deleted);
        if (!m || !canSee(f, f.channels.get(m.channelId))) throw new ConnectError("message not found", Code.NotFound);
        if (m.authorId === f.meId) throw new ConnectError("you cannot report your own message", Code.InvalidArgument);
        f.reports = f.reports.filter((r) => !(r.message?.id === m.id && r.reporter?.id === f.meId));
        f.reports.unshift(
          create(ReportSchema, {
            id: id("r"),
            message: create(MessageSchema, { id: m.id, channelId: m.channelId, authorId: m.authorId, text: m.text, createdAtMs: m.createdAtMs }),
            dm: f.channels.get(m.channelId)!.kind === ChannelKind.DM,
            author: f.members.get(m.authorId),
            reporter: me(),
            note: req.note,
            reportedAtMs: BigInt(Date.now()),
          }),
        );
        return {};
      },
      listReports(req: { resolved: boolean }) {
        mod();
        return {
          reports: f.reports.filter((r) => !!r.resolvedAtMs === req.resolved && (me().role === MemberRole.OWNER || me().role > (r.author?.role ?? 0))),
        };
      },
      resolveReport(req: { reportId: string }) {
        mod();
        const r = f.reports.find((x) => x.id === req.reportId);
        if (!r) throw new ConnectError("report not found", Code.NotFound);
        for (const x of f.reports)
          if (x.message?.id === r.message?.id && !x.resolvedAtMs) {
            x.resolvedAtMs = BigInt(Date.now());
            x.resolvedBy = me();
          }
        return {};
      },
      createInvite(req: { expiresInSeconds: bigint; maxUses: number }) {
        admin();
        const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"[b % 32]).join("");
        const now = BigInt(Date.now());
        const invite = create(InviteSchema, {
          code,
          createdBy: f.meId,
          createdAtMs: now,
          expiresAtMs: req.expiresInSeconds ? now + req.expiresInSeconds * 1000n : 0n,
          maxUses: req.maxUses,
        });
        f.invites.unshift(invite);
        return { invite };
      },
      listInvites() {
        admin();
        return { invites: f.invites };
      },
      revokeInvite(req: { code: string }) {
        admin();
        f.invites = f.invites.filter((i) => i.code !== req.code);
        return {};
      },
      updateServerSettings(req: { inviteOnly?: boolean; channelMode: ChannelMode; description?: string; bannerId?: string; iconId?: string; retentionDays?: number; setupDone: boolean }) {
        if (req.retentionDays !== undefined) f.info.retentionDays = req.retentionDays;
        admin();
        if (req.setupDone) f.info.needsSetup = false;
        if (req.inviteOnly !== undefined) f.info.inviteOnly = req.inviteOnly;
        if (req.description !== undefined) f.info.description = req.description.trim();
        if (req.bannerId !== undefined) f.info.banner = req.bannerId ? image(req.bannerId) : undefined;
        if (req.iconId !== undefined) f.info.iconUrl = req.iconId ? image(req.iconId).url : "";
        if (req.description !== undefined || req.bannerId !== undefined || req.iconId !== undefined || req.setupDone) emit(f, { case: "serverUpdated", value: true });
        if (req.channelMode && req.channelMode !== f.mode) {
          f.mode = req.channelMode;
          // OPT_IN to ROLES puts everyone in everything they can see.
          if (f.mode === ChannelMode.ROLES) {
            for (const cid of f.notIn) emit(f, { case: "channelCreated", value: f.channels.get(cid)! });
            f.notIn.clear();
          }
          emit(f, { case: "channelModeChanged", value: f.mode });
        }
        return { inviteOnly: f.info.inviteOnly, channelMode: f.mode, description: f.info.description, banner: f.info.banner, iconUrl: f.info.iconUrl, retentionDays: f.info.retentionDays };
      },
      createRole(req: { name: string; color: string }) {
        admin();
        if (!req.name.trim()) throw new ConnectError("a role needs a name", Code.InvalidArgument);
        if (f.roles.some((r) => r.name.toLowerCase() === req.name.trim().toLowerCase())) throw new ConnectError("a role with that name exists", Code.AlreadyExists);
        const role = create(RoleSchema, { id: id("r"), name: req.name.trim(), color: req.color, position: f.roles.length });
        f.roles.push(role);
        emit(f, { case: "roleUpdated", value: role });
        return { role };
      },
      updateRole(req: { roleId: string; name?: string; color?: string; position?: number }) {
        admin();
        const role = f.roles.find((r) => r.id === req.roleId);
        if (!role) throw new ConnectError("role not found", Code.NotFound);
        if (req.name !== undefined) role.name = req.name;
        if (req.color !== undefined) role.color = req.color;
        if (req.position !== undefined) role.position = req.position;
        emit(f, { case: "roleUpdated", value: role });
        return { role };
      },
      deleteRole(req: { roleId: string }) {
        admin();
        const gated = [...f.channels.values()].filter((c) => c.roleIds.includes(req.roleId));
        if (gated.length) throw new ConnectError(`this role limits ${gated.map((c) => `#${c.name}`).join(", ")}; change who can see those channels first`, Code.FailedPrecondition);
        f.roles = f.roles.filter((r) => r.id !== req.roleId);
        for (const m of f.members.values()) m.roleIds = m.roleIds.filter((r) => r !== req.roleId);
        emit(f, { case: "roleDeleted", value: req.roleId });
        return {};
      },
      setMemberRoles(req: { memberId: string; roleIds: string[] }) {
        admin();
        const m = f.members.get(req.memberId);
        if (!m) throw new ConnectError("member not found", Code.NotFound);
        m.roleIds = req.roleIds.filter((r) => f.roles.some((x) => x.id === r));
        emit(f, { case: "memberUpdated", value: m });
        return { member: m };
      },
      getMe() {
        need();
        // 1038: version fields go to admins and the owner only, like the server.
        if (me().role < MemberRole.ADMIN) return { member: me() };
        return { member: me(), serverVersion: "0.7.2", serverTrack: "stable", updateAvailable: "0.7.3" };
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
          channels: [...f.channels.values()].filter((c) => inside(f, c)),
          members: [...f.members.values()],
          readStates: [...f.reads.values()].filter((r) => inside(f, f.channels.get(r.channelId))),
          roles: [...f.roles].sort((a, b) => a.position - b.position),
          channelMode: f.mode,
          blockedMemberIds: [...f.blocked],
          mutedMemberIds: [...f.muted],
          openReports: me().role >= MemberRole.MODERATOR ? f.reports.filter((r) => !r.resolvedAtMs).length : 0,
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
          // Like the real server: a heartbeat at once, so the client knows the stream is open.
          yield create(EventSchema, { atMs: BigInt(Date.now()), kind: { case: "heartbeat", value: true } });
          if (req.afterSeq < f.logStart) {
            yield create(EventSchema, { kind: { case: "resync", value: true } });
            return;
          }
          for (const e of f.log) if (e.seq > req.afterSeq && delivered(f, e)) yield e;
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
        admin();
        if ([...f.channels.values()].some((c) => c.name === req.name)) throw new ConnectError("a channel with that name exists", Code.AlreadyExists);
        const position = Math.max(0, ...[...f.channels.values()].filter((c) => c.category === req.category).map((c) => c.position + 1));
        const ch = create(ChannelSchema, {
          ...req,
          id: id("c"),
          position,
          memberIds: req.kind === ChannelKind.PRIVATE ? [f.meId] : [],
          createdAtMs: BigInt(Date.now()),
        });
        f.channels.set(ch.id, ch);
        emit(f, { case: "channelCreated", value: ch });
        return { channel: ch };
      },
      updateChannel(req: { channelId: string; name?: string; topic?: string; category?: string; position?: number; headerImageId?: string; postRoles?: { roleIds: string[] } }) {
        admin();
        const ch = f.channels.get(req.channelId);
        if (!ch) throw new ConnectError("channel not found", Code.NotFound);
        if (req.headerImageId !== undefined) ch.headerImage = req.headerImageId ? image(req.headerImageId) : undefined;
        if (req.postRoles) ch.postRoleIds = [...new Set(req.postRoles.roleIds)].sort();
        for (const k of ["name", "topic", "category", "position"] as const) {
          if (req[k] !== undefined) (ch as Record<string, unknown>)[k] = req[k];
        }
        emit(f, { case: "channelUpdated", value: ch });
        return { channel: ch };
      },
      browseChannels() {
        need();
        // ponytail: fake count is everyone, minus me when I have not joined.
        const n = (c: Channel) => f.members.size - (f.notIn.has(c.id) ? 1 : 0);
        return { channels: [...f.channels.values()].filter((c) => c.kind === ChannelKind.TEXT && canSee(f, c)).map((c) => ({ ...c, memberCount: n(c) })) };
      },
      joinChannel(req: { channelId: string }) {
        need();
        const ch = f.channels.get(req.channelId);
        if (f.mode !== ChannelMode.OPT_IN) throw new ConnectError("everyone is in every channel they can see here", Code.FailedPrecondition);
        if (!canSee(f, ch) || ch!.kind !== ChannelKind.TEXT) throw new ConnectError("channel not found", Code.NotFound);
        if (f.notIn.delete(ch!.id)) emit(f, { case: "channelCreated", value: ch! });
        return { channel: ch };
      },
      leaveChannel(req: { channelId: string }) {
        need();
        const ch = f.channels.get(req.channelId);
        if (f.mode !== ChannelMode.OPT_IN) throw new ConnectError("everyone is in every channel they can see here", Code.FailedPrecondition);
        if (!inside(f, ch) || ch!.kind !== ChannelKind.TEXT) throw new ConnectError("channel not found", Code.NotFound);
        emit(f, { case: "channelDeleted", value: ch!.id });
        f.notIn.add(ch!.id);
        return {};
      },
      setChannelAccess(req: { channelId: string; roleIds: string[]; isDefault: boolean }) {
        admin();
        const ch = f.channels.get(req.channelId);
        if (!ch || ch.kind !== ChannelKind.TEXT) throw new ConnectError("channel not found", Code.NotFound);
        ch.roleIds = req.roleIds.filter((r) => f.roles.some((x) => x.id === r));
        ch.isDefault = req.isDefault;
        emit(f, { case: "channelUpdated", value: ch });
        return { channel: ch };
      },
      openDM(req: { memberIds: string[] }) {
        need();
        const want = [...new Set([f.meId, ...req.memberIds])].sort().join();
        let ch = [...f.channels.values()].find((c) => c.kind === ChannelKind.DM && [...c.memberIds].sort().join() === want);
        checkBlocks(f, req.memberIds);
        if (ch) unhide(f, ch);
        else {
          ch = create(ChannelSchema, { id: id("d"), kind: ChannelKind.DM, memberIds: want.split(","), createdAtMs: BigInt(Date.now()) });
          f.channels.set(ch.id, ch);
          emit(f, { case: "channelCreated", value: ch });
        }
        return { channel: ch };
      },
      listMessages(req: { channelId: string; threadRootId: string; beforeId: string; afterId: string; aroundId: string; limit: number }) {
        need();
        if (!canSee(f, f.channels.get(req.channelId))) throw new ConnectError("channel not found", Code.NotFound);
        let list = f.messages.filter((m) =>
          req.threadRootId ? m.threadRootId === req.threadRootId : m.channelId === req.channelId && !m.threadRootId,
        );
        list = list.filter((m) => !m.deleted || m.replyCount > 0);
        const limit = Math.min(req.limit || 50, 200);
        const at = (id: string) => list.findIndex((m) => m.id === id);
        if (req.aroundId) {
          const lo = Math.max(0, at(req.aroundId) - (limit >> 1));
          return { messages: list.slice(lo, lo + limit), hasMore: lo > 0, hasMoreAfter: lo + limit < list.length };
        }
        if (req.afterId) {
          const rest = list.slice(at(req.afterId) + 1);
          return { messages: rest.slice(0, limit), hasMore: false, hasMoreAfter: rest.length > limit };
        }
        if (req.beforeId) list = list.slice(0, Math.max(0, at(req.beforeId)));
        return { messages: list.slice(-limit), hasMore: list.length > limit };
      },
      sendMessage(req: { channelId: string; text: string; threadRootId: string; clientId: string; attachmentIds: string[] }) {
        need();
        mustBeIn(f, req.channelId);
        if (!inside(f, f.channels.get(req.channelId))) throw new ConnectError("channel not found", Code.NotFound);
        const target = f.channels.get(req.channelId)!;
        if (target.kind === ChannelKind.DM) checkBlocks(f, target.memberIds);
        if (!req.threadRootId && !mayPost(target, f.members.get(f.meId)))
          throw new ConnectError(`your roles cannot post in #${target.name}; reply in a thread`, Code.PermissionDenied);
        if (!req.text.trim() && !req.attachmentIds.length) throw new ConnectError("message is empty", Code.InvalidArgument);
        const dup = req.clientId && f.messages.find((m) => m.clientId === req.clientId);
        if (dup) return { message: dup };
        const atts = req.attachmentIds.map((a) => f.uploads.get(a)).filter((a): a is Attachment => !!a);
        const m = post(f, req.channelId, f.meId, req.text, req.threadRootId, req.clientId, atts);
        f.reads.set(req.channelId, create(ReadStateSchema, { channelId: req.channelId, lastReadSeq: m.seq }));
        return { message: m };
      },
      getLinkPreviews(req: { messageId: string }) {
        need();
        const m = msg(req.messageId);
        const urls = m.text.match(/https?:\/\/[^\s<]*[^\s<.,:;"')\]!?]/g) ?? [];
        return { previews: urls.filter((u) => FAKE_PREVIEWS[u]).map((u) => ({ url: u, ...FAKE_PREVIEWS[u] })) };
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
        mustBeIn(f, m.channelId);
        let r = m.reactions.find((x) => x.emoji === req.emoji);
        if (!r && !req.remove) m.reactions.push((r = create(ReactionSchema, { emoji: req.emoji })));
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
      addChannelMembers(req: { channelId: string; memberIds: string[] }) {
        need();
        const ch = f.channels.get(req.channelId);
        if (!canSee(f, ch) || ch!.kind !== ChannelKind.PRIVATE) throw new ConnectError("channel not found", Code.NotFound);
        ch!.memberIds = [...new Set([...ch!.memberIds, ...req.memberIds.filter((m) => f.members.has(m))])];
        emit(f, { case: "channelUpdated", value: ch! });
        return { channel: ch };
      },
      removeChannelMember(req: { channelId: string; memberId: string }) {
        need();
        const ch = f.channels.get(req.channelId);
        if (!inside(f, ch)) throw new ConnectError("channel not found", Code.NotFound);
        if (ch!.kind === ChannelKind.DM && req.memberId === f.meId) {
          f.hidden.add(ch!.id);
          emit(f, { case: "channelDeleted", value: ch!.id });
          return { channel: ch };
        }
        if (ch!.kind !== ChannelKind.PRIVATE) throw new ConnectError("you can leave a DM, and remove members from private channels only", Code.InvalidArgument);
        const target = f.members.get(req.memberId);
        if (req.memberId !== f.meId && !(me().role >= MODERATOR && me().role > (target?.role ?? 0)))
          throw new ConnectError("you can't remove them", Code.PermissionDenied);
        ch!.memberIds = ch!.memberIds.filter((m) => m !== req.memberId);
        emit(f, req.memberId === f.meId ? { case: "channelDeleted", value: ch!.id } : { case: "channelUpdated", value: ch! });
        return { channel: ch };
      },
      search(req: { query: string; channelId: string; limit: number }) {
        need();
        const q = req.query.toLowerCase();
        const hits = f.messages.filter(
          (m) =>
            !m.deleted &&
            m.text.toLowerCase().includes(q) &&
            (req.channelId ? m.channelId === req.channelId && canSee(f, f.channels.get(m.channelId)) : inside(f, f.channels.get(m.channelId))),
        );
        return { messages: hits.reverse().slice(0, req.limit || 20) };
      },
    },
    bot: {
      createBot(req: { username: string; displayName: string; avatarUrl: string; bio: string }) {
        admin();
        const bot = create(MemberSchema, { ...req, id: id("m"), kind: MemberKind.BOT, role: MEMBER, presence: ONLINE });
        f.members.set(bot.id, bot);
        emit(f, { case: "memberJoined", value: bot });
        return { bot, token: `sbb_${crypto.randomUUID().replace(/-/g, "")}` };
      },
      listBots() {
        admin();
        return { bots: [...f.members.values()].filter((m) => m.kind === MemberKind.BOT) };
      },
      rotateBotToken() {
        admin();
        return { token: `sbb_${crypto.randomUUID().replace(/-/g, "")}` };
      },
      deleteBot(req: { botId: string }) {
        admin();
        f.members.delete(req.botId);
        emit(f, { case: "memberLeft", value: req.botId });
        return {};
      },
      listPlugins() {
        admin();
        return { plugins: f.plugins };
      },
      installPlugin(req: { name: string; source: string }) {
        admin();
        if (/^\s*function \(/.test(req.source)) throw new ConnectError("plugin did not load: SyntaxError: unexpected token", Code.InvalidArgument);
        const p = create(PluginSchema, { name: req.name, enabled: true, running: true, botId: id("m") });
        f.plugins = [...f.plugins.filter((x) => x.name !== req.name), p].sort((a, b) => a.name.localeCompare(b.name));
        emit(f, { case: "pluginsChanged", value: true });
        return { plugin: p };
      },
      setPluginEnabled(req: { name: string; enabled: boolean }) {
        admin();
        f.plugins = f.plugins.map((p) => (p.name === req.name ? { ...p, enabled: req.enabled, running: req.enabled && !p.error.startsWith("SyntaxError") } : p));
        emit(f, { case: "pluginsChanged", value: true });
        return { plugin: f.plugins.find((p) => p.name === req.name) };
      },
      deletePlugin(req: { name: string }) {
        admin();
        f.plugins = f.plugins.filter((p) => p.name !== req.name);
        emit(f, { case: "pluginsChanged", value: true });
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
  // Message link previews (1109): links to a message here, one in another community, one in a
  // community I have not joined and one that does not exist. Only the first two get a preview.
  const app = location.origin + location.pathname + location.search;
  const [sb, owls, press] = SEEDS.filter((s) => s.url !== "https://pottery.thursdays.club").map((s) => fakes.get(s.url)!);
  const first = (f: Fake, name: string) => f.messages.find((m) => f.channels.get(m.channelId)!.name === name && !m.threadRootId)!;
  const link = (f: Fake, m: Pick<Message, "id" | "channelId" | "threadRootId">) => app + messageHash(f.info.baseUrl, m);
  const general = [...sb.channels.values()].find((c) => c.name === "general")!;
  const m = create(MessageSchema, {
    id: id("x"),
    channelId: general.id,
    authorId: [...sb.members.values()].find((x) => x.username === "jun")!.id,
    text: `Two threads worth reading before the call: ${link(sb, first(sb, "design"))} and the night window idea ${link(owls, first(owls, "3am-thoughts"))}\n\nThese should stay plain links: ${link(press, press.messages[0] ?? { id: "x", channelId: "c", threadRootId: "" })} ${link(sb, { id: "x-gone", channelId: general.id, threadRootId: "" })}`,
    createdAtMs: BigInt(now - 60_000),
  });
  m.seq = m.createdSeq = ++sb.seq;
  sb.messages.push(m);
  // Link previews (1110): fake.getLinkPreviews answers for the links in FAKE_PREVIEWS.
  const lp = create(MessageSchema, {
    id: id("x"),
    channelId: general.id,
    authorId: [...sb.members.values()].find((x) => x.username !== "jun" && x.id !== sb.meId)!.id,
    text: "Found a launcher that does everything: https://macotron.statico.io/ (the docs are good too https://example.com/docs)",
    createdAtMs: BigInt(now - 30_000),
  });
  lp.seq = lp.createdSeq = ++sb.seq;
  sb.messages.push(lp);
  general.lastMessageSeq = sb.logStart = sb.seq;
}

const FAKE_PREVIEWS: Record<string, { title: string; description: string; siteName: string; imageUrl: string }> = {
  "https://macotron.statico.io/": {
    title: "Macotron does everything.",
    description:
      "Customization and automation with a quick launch bar, global hotkeys, menu bar items, and APIs for everything you can think of. Open-source and free.",
    siteName: "Macotron",
    imageUrl:
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#3550f0"/><stop offset="1" stop-color="#e8344e"/></linearGradient></defs><rect width="160" height="160" fill="url(#g)"/><text x="80" y="104" font-family="sans-serif" font-size="72" font-weight="700" fill="#fff" text-anchor="middle">M</text></svg>`,
      ),
  },
  "https://example.com/docs": { title: "Example Domain", description: "This domain is for use in illustrative examples in documents.", siteName: "example.com", imageUrl: "" },
};

/** Transport for a fake community, or null when no fake server lives at that URL. */
export function fakeTransport(url: string): Transport | null {
  init();
  const f = fakes.get(url);
  if (!f) return null;
  const s = service(f);
  return createRouterTransport(
    (router) => {
      router.service(ServerService, s.server as never);
      router.service(ChatService, s.chat as never);
      router.service(BotService, s.bot as never);
    },
    { transport: { interceptors: LAG ? [(next) => (req) => new Promise((r) => setTimeout(r, LAG)).then(() => next(req))] : [] } },
  );
}

// ?fake=1&lag=1500 answers every call that many ms late, to see loading states.
const LAG = Number(new URLSearchParams(location.search).get("lag")) || 0;

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
  const poster = file.type.startsWith("video/") ? await videoPoster(file) : null;
  const a = create(AttachmentSchema, {
    posterUrl: poster ? URL.createObjectURL(poster) : "",
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
function simulateOnce(): boolean {
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
