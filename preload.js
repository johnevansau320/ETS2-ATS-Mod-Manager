const { contextBridge, ipcRenderer } = require('electron');
const call = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
contextBridge.exposeInMainWorld('api', {
  games: call('games'), profiles: call('profiles'), mods: call('mods'),
  loadProfile: call('load-profile'), saveProfile: call('save-profile'),
  folders: call('folders'), addFolder: call('add-folder'), removeFolder: call('remove-folder'),
  gameVersion: call('game-version'), findUpdate: call('find-update'),
  backup: call('backup'), launch: call('launch'), reveal: call('reveal'),
});
