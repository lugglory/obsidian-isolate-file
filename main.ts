import {
	App,
	FileSystemAdapter,
	FuzzySuggestModal,
	Menu,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFolder,
} from "obsidian";

// ---------------------------------------------------------------------------
// Node modules (desktop only). Required lazily so the plugin still loads on
// mobile, where `require` is unavailable — the cross-vault feature is simply
// disabled there.
// ---------------------------------------------------------------------------

type NodeModules = {
	fs: typeof import("fs");
	path: typeof import("path");
	os: typeof import("os");
	crypto: typeof import("crypto");
	process: NodeJS.Process;
};

function loadNode(): NodeModules | null {
	const req = (window as unknown as { require?: (id: string) => unknown })
		.require;
	if (typeof req !== "function") return null;
	try {
		return {
			fs: req("fs") as NodeModules["fs"],
			path: req("path") as NodeModules["path"],
			os: req("os") as NodeModules["os"],
			crypto: req("crypto") as NodeModules["crypto"],
			process: req("process") as NodeJS.Process,
		};
	} catch (e) {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Shared path helpers
// ---------------------------------------------------------------------------

function isDescendantOf(path: string, ancestorPath: string): boolean {
	if (ancestorPath === "") return true;
	return path === ancestorPath || path.startsWith(ancestorPath + "/");
}

// Obsidian's renameFile does not create missing parent folders, so we build
// the destination folder chain ourselves before moving.
async function ensureFolder(app: App, path: string): Promise<void> {
	if (path === "" || app.vault.getAbstractFileByPath(path)) return;
	const parent = path.substring(0, path.lastIndexOf("/"));
	await ensureFolder(app, parent);
	if (!app.vault.getAbstractFileByPath(path)) {
		try {
			await app.vault.createFolder(path);
		} catch (e) {
			// Ignore the "folder already exists" race with concurrent moves.
		}
	}
}

// Drop items already nested inside another selected folder, since moving the
// parent already carries them along.
function topLevelSelection(files: TAbstractFile[]): TAbstractFile[] {
	const folderPaths = files
		.filter((f): f is TFolder => f instanceof TFolder)
		.map((f) => f.path);
	return files.filter(
		(f) => !folderPaths.some((p) => p !== f.path && isDescendantOf(f.path, p))
	);
}

// ---------------------------------------------------------------------------
// In-vault isolate (preserve full vault path under a destination folder)
// ---------------------------------------------------------------------------

async function isolateFile(
	app: App,
	file: TAbstractFile,
	destFolder: TFolder
): Promise<void> {
	const newPath =
		destFolder.path === "" ? file.path : `${destFolder.path}/${file.path}`;

	if (newPath === file.path) {
		new Notice(`"${file.path}" is already there.`);
		return;
	}

	if (file instanceof TFolder && isDescendantOf(destFolder.path, file.path)) {
		new Notice("Can't isolate a folder into itself or its own subfolder.");
		return;
	}

	if (app.vault.getAbstractFileByPath(newPath)) {
		new Notice(`"${newPath}" already exists.`);
		return;
	}

	try {
		const parentPath = newPath.substring(0, newPath.lastIndexOf("/"));
		await ensureFolder(app, parentPath);
		await app.fileManager.renameFile(file, newPath);
		new Notice(`Isolated to "${newPath}"`);
	} catch (e) {
		new Notice(`Failed to isolate "${file.path}": ${e.message ?? e}`);
	}
}

async function isolateFiles(
	app: App,
	files: TAbstractFile[],
	destFolder: TFolder
): Promise<void> {
	for (const file of topLevelSelection(files)) {
		await isolateFile(app, file, destFolder);
	}
}

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	constructor(
		app: App,
		private recentPaths: string[],
		private onChoose: (folder: TFolder) => void
	) {
		super(app);
		this.setPlaceholder("Choose a destination folder...");
	}

	getItems(): TFolder[] {
		const folders: TFolder[] = [];
		const collect = (folder: TFolder) => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) collect(child);
			}
		};
		collect(this.app.vault.getRoot());

		// Surface recently used destinations (that still exist) at the top,
		// in most-recent-first order, when the search box is empty.
		const byPath = new Map(folders.map((f) => [f.path, f]));
		const recent: TFolder[] = [];
		for (const p of this.recentPaths) {
			const folder = byPath.get(p);
			if (folder) recent.push(folder);
		}
		const recentSet = new Set(recent.map((f) => f.path));
		const rest = folders.filter((f) => !recentSet.has(f.path));
		return [...recent, ...rest];
	}

	getItemText(folder: TFolder): string {
		return folder.path === "" ? "/" : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

// ---------------------------------------------------------------------------
// Cross-vault isolate (move to another vault, verified by checksum)
// ---------------------------------------------------------------------------

interface RegisteredVault {
	name: string;
	path: string;
}

function obsidianConfigDir(node: NodeModules): string | null {
	const { path, os, process } = node;
	const platform = os.platform();
	const home = os.homedir();
	if (platform === "win32") {
		const appData =
			process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
		return path.join(appData, "obsidian");
	}
	if (platform === "darwin") {
		return path.join(home, "Library", "Application Support", "obsidian");
	}
	const xdg = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
	return path.join(xdg, "obsidian");
}

// A directory is treated as an Obsidian vault only if it contains `.obsidian`.
function isVaultDir(node: NodeModules, dir: string): boolean {
	try {
		return node.fs.statSync(node.path.join(dir, ".obsidian")).isDirectory();
	} catch (e) {
		return false;
	}
}

// Read Obsidian's (undocumented) vault list. Defensive: any shape mismatch or
// read error yields an empty list rather than a guess, so a future format
// change degrades to "no auto-suggestions", never a wrong move.
function readRegisteredVaults(node: NodeModules): RegisteredVault[] {
	const dir = obsidianConfigDir(node);
	if (!dir) return [];
	const file = node.path.join(dir, "obsidian.json");
	try {
		if (!node.fs.existsSync(file)) return [];
		const data = JSON.parse(node.fs.readFileSync(file, "utf8"));
		if (!data || typeof data !== "object" || typeof data.vaults !== "object")
			return [];
		const out: RegisteredVault[] = [];
		for (const entry of Object.values(data.vaults as Record<string, unknown>)) {
			if (
				entry &&
				typeof entry === "object" &&
				typeof (entry as { path?: unknown }).path === "string"
			) {
				const p = (entry as { path: string }).path;
				out.push({ name: node.path.basename(p), path: p });
			}
		}
		return out;
	} catch (e) {
		return [];
	}
}

function sha256(node: NodeModules, absPath: string): string {
	const buf = node.fs.readFileSync(absPath);
	return node.crypto.createHash("sha256").update(buf).digest("hex");
}

function collectFiles(node: NodeModules, absRoot: string): string[] {
	const stat = node.fs.statSync(absRoot);
	if (stat.isFile()) return [absRoot];
	const out: string[] = [];
	for (const entry of node.fs.readdirSync(absRoot)) {
		out.push(...collectFiles(node, node.path.join(absRoot, entry)));
	}
	return out;
}

function copyTree(node: NodeModules, src: string, dest: string): void {
	const stat = node.fs.statSync(src);
	if (stat.isDirectory()) {
		node.fs.mkdirSync(dest, { recursive: true });
		for (const entry of node.fs.readdirSync(src)) {
			copyTree(node, node.path.join(src, entry), node.path.join(dest, entry));
		}
	} else {
		node.fs.copyFileSync(src, dest);
	}
}

interface ManifestFileEntry {
	rel: string;
	sha256: string;
}

function appendManifest(
	node: NodeModules,
	targetVaultPath: string,
	entry: unknown
): void {
	const file = node.path.join(targetVaultPath, ".isolate-manifest.json");
	let arr: unknown[] = [];
	try {
		if (node.fs.existsSync(file)) {
			const parsed = JSON.parse(node.fs.readFileSync(file, "utf8"));
			if (Array.isArray(parsed)) arr = parsed;
		}
	} catch (e) {
		arr = [];
	}
	arr.push(entry);
	node.fs.writeFileSync(file, JSON.stringify(arr, null, 2), "utf8");
}

async function moveToVault(
	app: App,
	node: NodeModules,
	basePath: string,
	file: TAbstractFile,
	target: RegisteredVault,
	settings: IsolateFileSettings
): Promise<void> {
	const { path: p, fs } = node;

	if (!isVaultDir(node, target.path)) {
		new Notice(`"${target.path}" is not a valid vault (no .obsidian).`);
		return;
	}

	const srcAbs = p.join(basePath, file.path);
	const rel = settings.preservePath ? file.path : file.name;
	const destAbs = p.join(target.path, rel);

	// Guard: target must not sit inside the item being moved.
	const destInSrc =
		destAbs === srcAbs || destAbs.startsWith(srcAbs + p.sep);
	if (destInSrc) {
		new Notice("Can't move an item into itself.");
		return;
	}

	if (fs.existsSync(destAbs)) {
		new Notice(`"${rel}" already exists in "${target.name}".`);
		return;
	}

	const manifestFiles: ManifestFileEntry[] = [];
	try {
		fs.mkdirSync(p.dirname(destAbs), { recursive: true });
		copyTree(node, srcAbs, destAbs);

		// Verify every copied file byte-for-byte before removing the source.
		for (const sf of collectFiles(node, srcAbs)) {
			const relInside = p.relative(srcAbs, sf);
			const df = relInside === "" ? destAbs : p.join(destAbs, relInside);
			if (!fs.existsSync(df)) throw new Error(`missing copy: ${relInside}`);
			const srcHash = sha256(node, sf);
			if (srcHash !== sha256(node, df))
				throw new Error(`checksum mismatch: ${relInside || file.name}`);
			manifestFiles.push({
				rel: relInside || p.basename(srcAbs),
				sha256: srcHash,
			});
		}
	} catch (e) {
		// Roll back the partial copy; never touch the source on failure.
		try {
			fs.rmSync(destAbs, { recursive: true, force: true });
		} catch (_) {
			/* best effort */
		}
		new Notice(`Failed to move "${file.path}": ${e.message ?? e}`);
		return;
	}

	// Copy verified — now remove the source from this vault (respects the
	// user's trash preference and keeps Obsidian's index in sync).
	try {
		await app.fileManager.trashFile(file);
	} catch (e) {
		new Notice(
			`Copied & verified in "${target.name}", but couldn't remove the original: ${
				e.message ?? e
			}`
		);
		return;
	}

	if (settings.writeManifest) {
		try {
			appendManifest(node, target.path, {
				sourceVault: app.vault.getName(),
				sourcePath: file.path,
				destPath: rel,
				files: manifestFiles,
				movedAt: new Date().toISOString(),
			});
		} catch (e) {
			// Logging is best-effort; the move itself already succeeded.
		}
	}

	new Notice(`Isolated to vault "${target.name}" → ${rel}`);
}

class VaultSuggestModal extends FuzzySuggestModal<RegisteredVault> {
	constructor(
		app: App,
		private vaults: RegisteredVault[],
		private onChoose: (vault: RegisteredVault) => void
	) {
		super(app);
		this.setPlaceholder("Choose a destination vault...");
	}

	getItems(): RegisteredVault[] {
		return this.vaults;
	}

	getItemText(vault: RegisteredVault): string {
		return `${vault.name} — ${vault.path}`;
	}

	onChooseItem(vault: RegisteredVault): void {
		this.onChoose(vault);
	}
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface IsolateFileSettings {
	recentFolders: string[];
	destinationVaults: string[];
	preservePath: boolean;
	writeManifest: boolean;
}

const DEFAULT_SETTINGS: IsolateFileSettings = {
	recentFolders: [],
	destinationVaults: [],
	preservePath: true,
	writeManifest: true,
};

const MAX_RECENT_FOLDERS = 10;

export default class IsolateFilePlugin extends Plugin {
	settings: IsolateFileSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "isolate-active-file",
			name: "Isolate active file to folder...",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					this.pickFolder((folder) => isolateFile(this.app, file, folder));
				}
				return true;
			},
		});

		this.addCommand({
			id: "isolate-active-file-to-vault",
			name: "Isolate active file to another vault...",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.desktopReady()) return false;
				if (!checking) {
					this.pickVault((node, base, vault) =>
						moveToVault(this.app, node, base, file, vault, this.settings)
					);
				}
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
				this.addMenuItems(menu, [file]);
			})
		);

		this.registerEvent(
			this.app.workspace.on(
				"files-menu",
				(menu: Menu, files: TAbstractFile[]) => {
					this.addMenuItems(menu, files);
				}
			)
		);

		this.addSettingTab(new IsolateFileSettingTab(this.app, this));
	}

	private addMenuItems(menu: Menu, files: TAbstractFile[]): void {
		const multi = files.length > 1;
		menu.addItem((item) => {
			item
				.setTitle(
					multi ? `Isolate ${files.length} items to folder...` : "Isolate to folder..."
				)
				.setIcon("corner-down-right")
				.onClick(() => {
					this.pickFolder((folder) => {
						if (multi) isolateFiles(this.app, files, folder);
						else isolateFile(this.app, files[0], folder);
					});
				});
		});

		if (!this.desktopReady()) return;
		menu.addItem((item) => {
			item
				.setTitle(
					multi
						? `Isolate ${files.length} items to another vault...`
						: "Isolate to another vault..."
				)
				.setIcon("vault")
				.onClick(() => {
					this.pickVault(async (node, base, vault) => {
						for (const f of topLevelSelection(files)) {
							await moveToVault(this.app, node, base, f, vault, this.settings);
						}
					});
				});
		});
	}

	private pickFolder(onChoose: (folder: TFolder) => void): void {
		new FolderSuggestModal(this.app, this.settings.recentFolders, (folder) => {
			void this.recordRecent(folder.path);
			onChoose(folder);
		}).open();
	}

	// Resolves the destination vault list (user-registered first, then any
	// still-valid vaults discovered from Obsidian's own list) and opens a picker.
	private pickVault(
		run: (node: NodeModules, basePath: string, vault: RegisteredVault) => void
	): void {
		const node = loadNode();
		const adapter = this.app.vault.adapter;
		if (!node || !(adapter instanceof FileSystemAdapter)) {
			new Notice("Moving to another vault is only available on desktop.");
			return;
		}
		const basePath = adapter.getBasePath();
		const vaults = this.resolveDestinationVaults(node, basePath);
		if (vaults.length === 0) {
			new Notice(
				"No destination vaults. Add one in Isolate File settings first."
			);
			return;
		}
		new VaultSuggestModal(this.app, vaults, (vault) =>
			run(node, basePath, vault)
		).open();
	}

	resolveDestinationVaults(
		node: NodeModules,
		currentBasePath: string
	): RegisteredVault[] {
		const norm = (s: string) => node.path.resolve(s).toLowerCase();
		const current = norm(currentBasePath);
		const seen = new Set<string>([current]);
		const out: RegisteredVault[] = [];

		const add = (v: RegisteredVault) => {
			const key = norm(v.path);
			if (seen.has(key)) return;
			seen.add(key);
			out.push(v);
		};

		for (const p of this.settings.destinationVaults) {
			add({ name: node.path.basename(p), path: p });
		}
		for (const v of readRegisteredVaults(node)) {
			if (isVaultDir(node, v.path)) add(v);
		}
		return out;
	}

	private desktopReady(): boolean {
		return (
			this.app.vault.adapter instanceof FileSystemAdapter &&
			loadNode() !== null
		);
	}

	private async recordRecent(path: string): Promise<void> {
		this.settings.recentFolders = [
			path,
			...this.settings.recentFolders.filter((p) => p !== path),
		].slice(0, MAX_RECENT_FOLDERS);
		await this.saveSettings();
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<IsolateFileSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...(data ?? {}),
			recentFolders: Array.isArray(data?.recentFolders)
				? data!.recentFolders.filter((p): p is string => typeof p === "string")
				: [],
			destinationVaults: Array.isArray(data?.destinationVaults)
				? data!.destinationVaults.filter(
						(p): p is string => typeof p === "string"
				  )
				: [],
		};
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

class IsolateFileSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: IsolateFilePlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Preserve relative path")
			.setDesc(
				"Recreate the item's original vault path under the destination (e.g. A/B/C stays A/B/C). Off: drop the item directly into the destination root."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.preservePath).onChange(async (v) => {
					this.plugin.settings.preservePath = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Write audit manifest")
			.setDesc(
				"When moving to another vault, append an entry (source, destination, SHA-256, time) to .isolate-manifest.json in the destination vault."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.writeManifest).onChange(async (v) => {
					this.plugin.settings.writeManifest = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Destination vaults")
			.setDesc(
				"Vaults Obsidian knows about appear in the picker automatically. Add others (a vault or plain folder Obsidian doesn't list) below."
			)
			.setHeading();

		const node = loadNode();
		if (!node) {
			containerEl.createEl("p", {
				text: "Moving to another vault is only available on desktop.",
			});
			return;
		}

		const manual = this.plugin.settings.destinationVaults;
		for (const vaultPath of manual) {
			new Setting(containerEl)
				.setName(node.path.basename(vaultPath))
				.setDesc(vaultPath)
				.addExtraButton((b) =>
					b
						.setIcon("trash")
						.setTooltip("Remove")
						.onClick(async () => {
							this.plugin.settings.destinationVaults = manual.filter(
								(p) => p !== vaultPath
							);
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}

		let inputPath = "";
		new Setting(containerEl)
			.setName("Add a vault manually")
			.setDesc("Absolute path to a vault or folder Obsidian doesn't list.")
			.addText((t) =>
				t
					.setPlaceholder("D:\\vaults\\secure-vault")
					.onChange((v) => (inputPath = v.trim()))
			)
			.addButton((b) =>
				b
					.setButtonText("Add")
					.setCta()
					.onClick(async () => {
						if (!inputPath) return;
						if (!isVaultDir(node, inputPath)) {
							new Notice(
								"That path is not a valid vault (no .obsidian folder)."
							);
							return;
						}
						if (!manual.includes(inputPath)) {
							manual.push(inputPath);
							await this.plugin.saveSettings();
						}
						this.display();
					})
			);
	}
}
