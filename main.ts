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
	constructor(app: App, private onChoose: (folder: TFolder) => void) {
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
		return folders;
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

export default class IsolateFilePlugin extends Plugin {
	onload(): void {
		this.addCommand({
			id: "isolate-active-file",
			name: "Isolate active file to folder...",
			checkCallback: (checking: boolean) => {
				const file = this.app.workspace.getActiveFile();
				if (!file) return false;
				if (!checking) {
					new FolderSuggestModal(this.app, (folder) =>
						isolateFile(this.app, file, folder)
					).open();
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
								new FolderSuggestModal(this.app, (folder) =>
									isolateFile(this.app, file, folder)
								).open();
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
								new FolderSuggestModal(this.app, (folder) =>
									isolateFiles(this.app, files, folder)
								).open();
							});
					});
				}
			)
		);
	}
}
