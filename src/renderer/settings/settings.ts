import { attachSettingsPage } from "./settings-page";

document.documentElement.dataset.page = "settings";
document.querySelector<HTMLLinkElement>("#settings-style")!.media = "all";
document.title = "Mosey 设置";
const host = document.createElement("div");
document.body.replaceChildren(host);
const detachSettingsPage = attachSettingsPage(host);
if (import.meta.hot) import.meta.hot.dispose(detachSettingsPage);
