'use strict';
const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('jane', {
  on:  (ch, fn) => ipcRenderer.on(ch, (_, ...a) => fn(...a)),
  off: (ch, fn) => ipcRenderer.removeListener(ch, fn),

  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close:    () => ipcRenderer.send('win:close'),

  checkActivation: () => ipcRenderer.invoke('activation:check'),
  activate:        key => ipcRenderer.invoke('activation:activate', key),
  activationInfo:  () => ipcRenderer.invoke('activation:info'),

  sendMessage:   (text, model) => ipcRenderer.send('chat:send', { text, model }),
  resetChat:     ()            => ipcRenderer.send('chat:reset'),
  generateTitle: messages      => ipcRenderer.invoke('chat:title', messages),

  listModels:      ()  => ipcRenderer.invoke('model:list'),
  setModel:        m   => ipcRenderer.send('model:set', m),
  pullModel:       m   => ipcRenderer.invoke('ollama:pull', m),
  openModelsFolder: () => ipcRenderer.invoke('model:open_folder'),
  downloadLlama:   ()  => ipcRenderer.invoke('llama:download'),

  setVoiceConfig:  cfg => ipcRenderer.send('voice:set', cfg),
  startListening:  ()  => ipcRenderer.send('voice:listen'),
  listVoices:      ()  => ipcRenderer.invoke('voice:list_voices'),

  whisperTranscribe:   audioPath => ipcRenderer.invoke('voice:whisper_transcribe', audioPath),
  setScreenConsent:    enabled   => ipcRenderer.send('screen:consent', enabled),
  captureVisionScreen: ()        => ipcRenderer.invoke('screen:capture_vision'),
  toggleOverlay:       show      => ipcRenderer.send('overlay:toggle', show),

  toggleFloat:   enable => ipcRenderer.send('island:toggle', enable),
  floatSend:     text   => ipcRenderer.send('island:send', text),
  wakeWord:      ()     => ipcRenderer.send('island:wakeword'),
  floatResize:   (w, h) => ipcRenderer.send('island:resize', { w, h }),

  // Legacy aliases
  toggleIsland:  enable => ipcRenderer.send('island:toggle', enable),
  islandSend:    text   => ipcRenderer.send('island:send', text),
  islandResize:  (w, h) => ipcRenderer.send('island:resize', { w, h }),

  approve: id => ipcRenderer.send('approval:respond', { approvalId: id, approved: true }),
  deny:    id => ipcRenderer.send('approval:respond', { approvalId: id, approved: false }),

  saveHistory: data => ipcRenderer.invoke('history:save', data),
  loadHistory: ()   => ipcRenderer.invoke('history:load'),

  getPrefs:  ()      => ipcRenderer.invoke('prefs:get'),
  setPrefs:  updates => ipcRenderer.invoke('prefs:set', updates),

  openExternal: url => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  },
  cloudApiCall: (provider, key, model, messages) => ipcRenderer.invoke('cloud:api_call', { provider, key, model, messages }),
  deviceCommand: (host, cmd) => ipcRenderer.invoke('device:send_command', { host, cmd }),
  onWhisperProgress: fn => ipcRenderer.on('whisper:download:progress', (_, d) => fn(d)),
  onWhisperDone:     fn => ipcRenderer.on('whisper:download:done',     (_, d) => fn(d)),
  onWhisperError:    fn => ipcRenderer.on('whisper:download:error',    (_, d) => fn(d)),

  // Setup / onboarding
  getCpuInfo:       ()    => ipcRenderer.invoke('system:cpu_info'),
  checkDeps:        gpu   => ipcRenderer.invoke('setup:check_deps', gpu),
  setupComplete:    cfg   => ipcRenderer.invoke('setup:complete', cfg),
  openHardwareSetup: ()   => ipcRenderer.send('onboard:open-settings'),
});
