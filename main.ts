import {
	App,
	FuzzySuggestModal,
	Menu,
	Notice,
	Plugin,
	TAbstractFile,
	TFolder,
} from "obsidian";

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
	// Skip items that are already nested inside another selected folder,
	// since moving the parent already carries them along.
	const folderPaths = files
		.filter((f): f is TFolder => f instanceof TFolder)
		.map((f) => f.path);
	const targets = files.filter(
		(f) => !folderPaths.some((p) => p !== f.path && isDescendantOf(f.path, p))
	);

	for (const file of targets) {
		await isolateFile(app, file, destFolder);
	}
}

const MAX_RECENT_FOLDERS = 10;

interface IsolateFileData {
	recentFolders: string[];
}

export default class IsolateFilePlugin extends Plugin {
	private recentFolders: string[] = [];

	async onload(): Promise<void> {
		const data = (await this.loadData()) as Partial<IsolateFileData> | null;
		this.recentFolders = Array.isArray(data?.recentFolders)
			? data!.recentFolders.filter((p): p is string => typeof p === "string")
			: [];

		this.addCommand({
			id: "isolate-active-file",
			name: "Isolate active file to folder...",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					this.pickDestination((folder) =>
						isolateFile(this.app, file, folder)
					);
				}
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(menu: Menu, file: TAbstractFile) => {
					menu.addItem((item) => {
						item
							.setTitle("Isolate to folder...")
							.setIcon("corner-down-right")
							.onClick(() => {
								this.pickDestination((folder) =>
									isolateFile(this.app, file, folder)
								);
							});
					});
				}
			)
		);

		this.registerEvent(
			this.app.workspace.on(
				"files-menu",
				(menu: Menu, files: TAbstractFile[]) => {
					menu.addItem((item) => {
						item
							.setTitle(`Isolate ${files.length} items to folder...`)
							.setIcon("corner-down-right")
							.onClick(() => {
								this.pickDestination((folder) =>
									isolateFiles(this.app, files, folder)
								);
							});
					});
				}
			)
		);
	}

	private pickDestination(onChoose: (folder: TFolder) => void): void {
		new FolderSuggestModal(this.app, this.recentFolders, (folder) => {
			void this.recordRecent(folder.path);
			onChoose(folder);
		}).open();
	}

	private async recordRecent(path: string): Promise<void> {
		this.recentFolders = [
			path,
			...this.recentFolders.filter((p) => p !== path),
		].slice(0, MAX_RECENT_FOLDERS);
		await this.saveData({ recentFolders: this.recentFolders });
	}
}
