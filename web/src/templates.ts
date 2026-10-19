// Starting layouts for a new community (1286). Plain data: the setup wizard applies one with
// the ordinary admin calls. Channel names follow what busy Slack workspaces and Discord servers use.
import type { IconName } from "./ui";

interface TemplateChannel {
  name: string;
  topic: string;
  /** Staff room: only the template's role (and admins) can see it (1291). */
  private?: boolean;
  /** Slack-style communities only: new members join it automatically. */
  default?: boolean;
  /** Channel.post_role_ids (1308): who starts posts; everyone reacts and replies in threads. */
  postRoles?: string[];
}

/** The team talks, members listen. */
const STAFF = ["admin", "moderator"];

export interface Template {
  id: string;
  name: string;
  blurb: string;
  icon: IconName;
  /** Slack-style: members browse and join channels. Otherwise everyone is in every channel they can see. */
  optIn: boolean;
  inviteOnly: boolean;
  description: string;
  /** The channel the starter message goes to. */
  welcome: string;
  /** Starter message, posted as the owner. {name} becomes the community name. */
  message: string;
  /** Role made with the template; give it to someone to let them into the staff rooms (1291). */
  role?: string;
  /** Sidebar sections in order; "" is the plain "Channels" section. */
  sections: [category: string, channels: TemplateChannel[]][];
}

const general = (topic: string, extra: Partial<TemplateChannel> = {}): TemplateChannel => ({ name: "general", topic, ...extra });

export const TEMPLATES: Template[] = [
  {
    id: "team",
    role: "Leads",
    name: "Team workspace",
    blurb: "Slack-style. People browse channels and join the ones that fit their work.",
    icon: "briefcase",
    optIn: true,
    inviteOnly: true,
    description: "Where our team talks shop, shares wins and asks for help.",
    welcome: "general",
    message:
      "Welcome to {name}! Everyone starts in #general and #announcements. Use **Browse channels** to find the rest, and say hi in #introductions so people know who you are.",
    sections: [
      [
        "",
        [
          general("Team-wide questions and chat", { default: true }),
          { name: "announcements", topic: "Big news from the team. Reply in threads.", default: true, postRoles: STAFF },
          { name: "introductions", topic: "New here? Tell us what you work on.", default: true },
          { name: "help", topic: "Stuck on something? Ask here." },
          { name: "wins", topic: "Shipped something? Tell everyone." },
          { name: "random", topic: "Everything that isn't work" },
          { name: "leads", topic: "For team leads", private: true },
        ],
      ],
    ],
  },
  {
    id: "community",
    role: "Moderators",
    name: "Community",
    blurb: "Discord-style. A start-here section, open chat and a private room for moderators.",
    icon: "messages",
    optIn: false,
    inviteOnly: false,
    description: "A friendly place to hang out, share what you're making and help each other.",
    welcome: "welcome",
    message:
      "Welcome to {name}!\n\n1. Be kind. Disagree with ideas, not people.\n2. Keep it on topic, and take everything else to #off-topic.\n3. No spam or self-promotion without asking first.\n\nSay hi in #introductions, then jump into #general.",
    sections: [
      [
        "Start here",
        [
          { name: "welcome", topic: "Read this first", postRoles: STAFF },
          { name: "announcements", topic: "News from the moderators", postRoles: STAFF },
        ],
      ],
      [
        "Community",
        [
          general("Talk about anything"),
          { name: "introductions", topic: "Say hi and tell us about yourself" },
          { name: "show-and-tell", topic: "Share what you made" },
          { name: "off-topic", topic: "Everything else" },
        ],
      ],
      [
        "Help",
        [
          { name: "ask-for-help", topic: "Questions, big or small" },
          { name: "server-feedback", topic: "Ideas to make this place better" },
        ],
      ],
      ["Moderators", [{ name: "mod-chat", topic: "Moderators only", private: true }]],
    ],
  },
  {
    id: "product",
    role: "Team",
    name: "Product or service",
    blurb: "For the people who use what you make: news, support, bug reports and ideas.",
    icon: "package",
    optIn: false,
    inviteOnly: false,
    description: "News, help and feedback, straight from the team that makes it.",
    welcome: "welcome",
    message:
      "Welcome to {name}! This is where you can talk with the team and other users.\n\n- Need help? Ask in #support.\n- Found a bug? Post it in #bug-reports with what you did, what you expected and what happened.\n- Have an idea? One per thread in #feature-requests. React to the ones you want.\n\nWatch #announcements and #changelog for what's new.",
    sections: [
      [
        "Start here",
        [
          { name: "welcome", topic: "Read this first", postRoles: STAFF },
          { name: "announcements", topic: "News from the team", postRoles: STAFF },
          { name: "changelog", topic: "Every release, with notes", postRoles: STAFF },
        ],
      ],
      [
        "Community",
        [
          general("Chat with the team and other users"),
          { name: "show-and-tell", topic: "What you built with it" },
          { name: "off-topic", topic: "Everything else" },
        ],
      ],
      [
        "Help and feedback",
        [
          { name: "support", topic: "Ask the team and other users" },
          { name: "bug-reports", topic: "What you did, what you expected, what happened" },
          { name: "feature-requests", topic: "One idea per thread. React to vote." },
        ],
      ],
      [
        "Team",
        [
          { name: "team", topic: "Staff only", private: true },
          { name: "triage", topic: "Sort new bugs and requests", private: true },
        ],
      ],
    ],
  },
  {
    id: "gaming",
    role: "Officers",
    name: "Gaming group",
    blurb: "A crew, guild or clan. Find people to play with and plan game nights.",
    icon: "gamepad",
    optIn: false,
    inviteOnly: true,
    description: "Our crew's home base. Find a group, plan game nights and share your best moments.",
    welcome: "welcome",
    message:
      "Welcome to {name}! Looking for people to play with right now? Post in #looking-for-group. Game nights go in #game-night, and your best plays go in #clips. Be a good teammate.",
    sections: [
      [
        "Start here",
        [
          { name: "welcome", topic: "Read this first", postRoles: STAFF },
          { name: "announcements", topic: "Events, patches and server news", postRoles: STAFF },
        ],
      ],
      [
        "Hangout",
        [
          general("Talk about anything"),
          { name: "clips", topic: "Highlights, screenshots and funny moments" },
          { name: "memes", topic: "You know what goes here" },
        ],
      ],
      [
        "Play",
        [
          { name: "looking-for-group", topic: "Find people to play with right now" },
          { name: "game-night", topic: "Scheduled sessions and sign-ups" },
          { name: "strategy", topic: "Builds, guides and tips" },
          { name: "bot-commands", topic: "Talk to the bots here" },
        ],
      ],
      ["Officers", [{ name: "officers", topic: "Officers only", private: true }]],
    ],
  },
  {
    id: "private",
    name: "Private group",
    blurb: "Friends, family or a club. Small, invite only, a handful of channels.",
    icon: "house",
    optIn: false,
    inviteOnly: true,
    description: "Just us.",
    welcome: "general",
    message: "Welcome to {name}! It's just us in here. Plans go in #plans, pictures in #photos, and everything else right here.",
    sections: [
      [
        "",
        [
          general("Everyday chat"),
          { name: "plans", topic: "Meetups, trips and dates" },
          { name: "photos", topic: "Pictures worth keeping" },
          { name: "links", topic: "Articles, videos and recipes" },
        ],
      ],
    ],
  },
  {
    id: "scratch",
    name: "Start from scratch",
    blurb: "Just #general. Add channels yourself as you go.",
    icon: "hash",
    optIn: false,
    inviteOnly: true,
    description: "",
    welcome: "general",
    message: "Welcome to {name}! Say hello.",
    sections: [["", [general("")]]],
  },
];

/** Every channel in sidebar order, with its section. */
export const templateChannels = (t: Template) => t.sections.flatMap(([category, chans]) => chans.map((ch) => ({ ...ch, category })));
