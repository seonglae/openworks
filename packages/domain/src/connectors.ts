// Where content comes from and where it goes. Notion is one type among these,
// not the shape of the app: a type says which way it carries content, how it
// signs in, and which tier can reach it, a Convex function in the cloud or the
// worker on the owner's machine (a vault folder or a CLI login lives there).

export const CONNECTOR_DIRECTIONS = ["input", "output"] as const;
export type ConnectorDirection = (typeof CONNECTOR_DIRECTIONS)[number];

// How a type signs in, the first one being the one offered first. `env` is a
// Notion token set on the deployment, adopted as a connector so a deployment
// configured before connectors existed reads as connected.
export const CONNECTOR_AUTHS = ["oauth", "token", "env", "path", "cli", "app", "none"] as const;
export type ConnectorAuth = (typeof CONNECTOR_AUTHS)[number];

export const CONNECTOR_STATUSES = ["connected", "checking", "error"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

type Text = { ko: string; en: string };

export type ConnectorType = {
  key: string;
  label: string;
  directions: readonly ConnectorDirection[];
  auth: readonly ConnectorAuth[];
  runsOn: "cloud" | "worker";
  // Kept as rows in the connectors table. The CLI-backed types keep their
  // sign-in in appSettings, where the worker's verify step already writes it.
  stored: boolean;
  // Connected and checked, but nothing reads or writes through it yet.
  connectOnly?: boolean;
  blurb: Text;
};

export const CONNECTOR_TYPES = [
  {
    key: "links",
    label: "Links & text",
    directions: ["input"],
    auth: ["none"],
    runsOn: "cloud",
    stored: false,
    blurb: { ko: "링크, 글, 붙여 넣은 뉴스레터", en: "Links, text and pasted newsletters" },
  },
  {
    key: "iphone",
    label: "iPhone",
    directions: ["input"],
    auth: ["app"],
    runsOn: "cloud",
    stored: false,
    blurb: { ko: "스크린샷과 공유 시트", en: "Screenshots and the share sheet" },
  },
  {
    key: "gmail",
    label: "Gmail",
    directions: ["input", "output"],
    auth: ["cli"],
    runsOn: "worker",
    stored: false,
    blurb: { ko: "뉴스레터를 받고 digest를 보냄", en: "Newsletters in, the digest out" },
  },
  {
    key: "github",
    label: "GitHub",
    directions: ["input"],
    auth: ["cli"],
    runsOn: "worker",
    stored: false,
    blurb: { ko: "내 PR과 리뷰 요청", en: "Your pull requests and review requests" },
  },
  {
    key: "notion",
    label: "Notion",
    directions: ["output"],
    auth: ["oauth", "token", "env"],
    runsOn: "cloud",
    stored: true,
    blurb: {
      ko: "페이지에 수정 제안을 넣고 database에 새 페이지를 만듦",
      en: "Edits placed in pages, new pages in databases",
    },
  },
  {
    key: "obsidian",
    label: "Obsidian",
    directions: ["input", "output"],
    auth: ["path"],
    runsOn: "worker",
    stored: true,
    connectOnly: true,
    blurb: { ko: "이 컴퓨터의 vault 폴더", en: "A vault folder on this machine" },
  },
] as const satisfies readonly ConnectorType[];

export type ConnectorKey = (typeof CONNECTOR_TYPES)[number]["key"];
export const CONNECTOR_KEYS = CONNECTOR_TYPES.map((t) => t.key) as ConnectorKey[];
export const STORED_CONNECTOR_KEYS = ["notion", "obsidian"] as const satisfies readonly ConnectorKey[];
export type StoredConnectorKey = (typeof STORED_CONNECTOR_KEYS)[number];

export function connectorType(key: string): ConnectorType | undefined {
  return (CONNECTOR_TYPES as readonly ConnectorType[]).find((t) => t.key === key);
}

export const connectorsFor = (direction: ConnectorDirection): ConnectorType[] =>
  (CONNECTOR_TYPES as readonly ConnectorType[]).filter((t) => t.directions.includes(direction));
