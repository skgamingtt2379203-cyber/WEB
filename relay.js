/**
 * D4Hz WEB — Zero-Dependency Native Voice Relay Backend
 * Powered by Node.js 24 Native WebSocket, dgram (UDP), and crypto
 * No npm dependencies required!
 * Run: node relay.js
 */
const http = require('http');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const net = require('net');

let DAVESession = null;
try {
  DAVESession = require('@snazzah/davey').DAVESession;
  console.log('[Relay] 🔐 DAVE E2EE engine loaded successfully (@snazzah/davey)');
} catch (e) {
  console.warn('[Relay] DAVE E2EE package not loaded:', e.message);
}

const PORT = 7432;
const activeClients = new Map(); // token -> NativeVoiceClient
const voiceStatesByGuild = new Map(); // guildId -> Map(userId, voiceState)
let currentSession = null;

// ══════════════════════════════════════════════════════════
//  DISCORD PROFILE ACTIVITY & RICH PRESENCE (DEATH.gif)
// ══════════════════════════════════════════════════════════
const DEFAULT_DEATH_GIF_URL = 'https://files.catbox.moe/fi131s.gif';
const DISCORD_APP_IDS = ['383226320970055681', '1344697306231935048'];
let localDiscordPipe = null;

function buildDiscordActivity(details = 'D4Hz WEB — High Frequency Audio', state = 'Voice Amplifier Active ⚡', startTime = null, imageUrl = null) {
  const img = imageUrl || DEFAULT_DEATH_GIF_URL;
  return {
    name: 'D4Hz',
    type: 0,
    application_id: DISCORD_APP_IDS[0],
    details: details,
    state: state,
    timestamps: {
      start: startTime || Date.now()
    },
    assets: {
      large_image: img,
      large_text: 'D4Hz — DEATH',
      small_image: img,
      small_text: 'D4Hz WEB'
    },
    buttons: [
      { label: 'D4Hz', url: 'https://github.com' }
    ]
  };
}

function updateLocalDiscordIpc(details, state, imageUrl = null) {
  if (process.platform !== 'win32') return;

  if (localDiscordPipe && !localDiscordPipe.destroyed) {
    sendIpcActivity(localDiscordPipe, details, state, imageUrl);
    return;
  }

  function tryConnectPipe(pipeIndex, appIdIndex = 0) {
    if (pipeIndex > 9) return;
    const pipePath = `\\\\?\\pipe\\discord-ipc-${pipeIndex}`;
    const clientId = DISCORD_APP_IDS[appIdIndex] || DISCORD_APP_IDS[0];

    try {
      const s = net.connect(pipePath, () => {
        localDiscordPipe = s;
        const handshake = JSON.stringify({ v: 1, client_id: clientId });
        const hBuf = Buffer.from(handshake);
        const hdr = Buffer.alloc(8);
        hdr.writeInt32LE(0, 0);
        hdr.writeInt32LE(hBuf.length, 4);
        s.write(Buffer.concat([hdr, hBuf]));
      });

      s.once('data', (d) => {
        try {
          const op = d.readInt32LE(0);
          const len = d.readInt32LE(4);
          const resStr = d.subarray(8, 8 + len).toString();
          if (resStr.includes('"code":4000') && appIdIndex + 1 < DISCORD_APP_IDS.length) {
            s.destroy();
            localDiscordPipe = null;
            tryConnectPipe(pipeIndex, appIdIndex + 1);
            return;
          }
        } catch (e) {}
        sendIpcActivity(s, details, state, imageUrl);
      });

      s.on('error', () => {
        if (localDiscordPipe === s) localDiscordPipe = null;
        tryConnectPipe(pipeIndex + 1, appIdIndex);
      });

      s.on('close', () => {
        if (localDiscordPipe === s) localDiscordPipe = null;
      });
    } catch (e) {
      tryConnectPipe(pipeIndex + 1, appIdIndex);
    }
  }

  tryConnectPipe(0);
}

function sendIpcActivity(socket, details, state, imageUrl = null) {
  try {
    const img = imageUrl || DEFAULT_DEATH_GIF_URL;
    const actPayload = JSON.stringify({
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: {
          name: 'D4Hz',
          type: 0,
          details: details || 'D4Hz WEB — High Frequency Audio',
          state: state || 'Voice Amplifier Active ⚡',
          timestamps: { start: Math.floor(Date.now() / 1000) },
          assets: {
            large_image: img,
            large_text: 'D4Hz — DEATH',
            small_image: img,
            small_text: 'D4Hz WEB'
          },
          buttons: [
            { label: 'D4Hz', url: 'https://github.com' }
          ]
        }
      },
      nonce: crypto.randomUUID()
    });
    const aBuf = Buffer.from(actPayload);
    const hdr = Buffer.alloc(8);
    hdr.writeInt32LE(1, 0);
    hdr.writeInt32LE(aBuf.length, 4);
    socket.write(Buffer.concat([hdr, aBuf]));
    console.log('[Relay] 🎮 Discord Desktop Profile Activity updated with DEATH.gif');
  } catch (e) {}
}

// ══════════════════════════════════════════════════════════
//  NATIVE DISCORD VOICE CLIENT (Zero-dependency Node 24)
// ══════════════════════════════════════════════════════════
class NativeVoiceClient {
  constructor(token, isBot = false, username = '') {
    this.token = token.trim();
    this.isBot = !!isBot;
    // Auto-detect bot tokens if not explicitly marked
    if (!this.isBot && this.token.startsWith('Bot ')) {
      this.isBot = true;
      this.token = this.token.slice(4).trim();
    }
    this.username = username || (this.isBot ? 'Bot' : 'User');

    // Gateway State
    this.gwWs = null;
    this.gwHb = null;
    this.gwSeq = null;
    this.userId = null;
    this.sessionId = null;
    this.guildId = null;
    this.channelId = null;
    this.voiceStateReceived = false;
    this.retried4006 = false;
    this._joinRetryInterval = null;

    // Voice Gateway State
    this.voiceWs = null;
    this.voiceHb = null;
    this.voiceToken = null;
    this.voiceEndpoint = null;
    this.ssrc = 0;
    this.voiceIp = null;
    this.voicePort = 0;
    this.secretKey = null;
    this.voiceMode = 'aead_aes256_gcm_rtpsize';
    this.udp = null;

    // Audio Repeating State
    this.isReady = false;
    this.seq = 1;
    this.timestamp = 0;
    this.packetCounter = 0;
    this.daveSession = null;
  }

  // 1. Connect to main Discord Gateway
  connectGateway(guildId, channelId) {
    this.guildId = String(guildId).trim();
    this.channelId = String(channelId).trim();

    return new Promise((resolve, reject) => {
      let resolved = false;
      let joinRetryInterval = null;

      const cleanupTimers = () => {
        if (joinRetryInterval) { clearInterval(joinRetryInterval); joinRetryInterval = null; }
        if (this._joinRetryInterval) { clearInterval(this._joinRetryInterval); this._joinRetryInterval = null; }
      };

      const timeout = setTimeout(() => {
        cleanupTimers();
        if (!resolved) {
          resolved = true;
          reject(new Error(`[${this.username}] Gateway connection timed out (VC ${this.channelId}). Check that this channel exists in the server and the account has permissions to connect.`));
        }
      }, 35000);

      try {
        const gwUrl = this.isBot
          ? 'wss://gateway.discord.gg/?v=10&encoding=json'
          : 'wss://gateway.discord.gg/?v=9&encoding=json';
        this.gwWs = new WebSocket(gwUrl);
      } catch (e) {
        clearTimeout(timeout);
        return reject(e);
      }

      this.gwWs.onopen = () => {
        console.log(`[${this.username}] Gateway WS connected (${this.isBot ? 'Bot v10' : 'User v9'})`);
      };

      this.gwWs.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.s) this.gwSeq = msg.s;

        switch (msg.op) {
          case 10: { // HELLO
            const interval = msg.d.heartbeat_interval;
            this._sendGwHeartbeat();
            this.gwHb = setInterval(() => this._sendGwHeartbeat(), interval);
            this._sendIdentify();
            break;
          }
          case 11: break; // Heartbeat ACK
          case 9: { // Invalid Session
            cleanupTimers();
            clearTimeout(timeout);
            if (!resolved) {
              resolved = true;
              reject(new Error(`[${this.username}] Invalid session / token rejected`));
            }
            break;
          }
          case 0: { // Dispatch
            if (msg.t === 'READY') {
              this.userId = String(msg.d.user.id);
              this.sessionId = String(msg.d.session_id);
              console.log(`[${this.username}] Gateway READY as ${msg.d.user.username} (${this.userId})`);

              // For user accounts, request lazy guild state so voice events are dispatched
              if (!this.isBot && this.guildId) {
                try {
                  this.gwWs.send(JSON.stringify({
                    op: 14,
                    d: {
                      guild_id: this.guildId,
                      typing: true,
                      threads: true,
                      activities: true
                    }
                  }));
                } catch (e) {}
              }

              // Initial Op 4 join attempt
              setTimeout(() => {
                this._sendJoinVC();
              }, 300);

              // Periodic retry every 2.5s until voiceStateReceived or resolved
              joinRetryInterval = setInterval(() => {
                if (!this.voiceStateReceived && !resolved && this.gwWs && this.gwWs.readyState === 1) {
                  console.log(`[${this.username}] Re-sending Op 4 join Voice Channel ${this.channelId}...`);
                  this._sendJoinVC();
                } else if (this.voiceStateReceived) {
                  cleanupTimers();
                }
              }, 2500);
              this._joinRetryInterval = joinRetryInterval;
            }

            if (msg.t === 'GUILD_CREATE') {
              if (String(msg.d.id) === this.guildId) {
                console.log(`[${this.username}] Target guild loaded: "${msg.d.name || msg.d.id}". Triggering Op 4 join VC...`);
                this._sendJoinVC();
              }
            }

            if (msg.t === 'VOICE_STATE_UPDATE' && msg.d) {
              // Cache voice state
              if (msg.d.guild_id) {
                const gId = String(msg.d.guild_id);
                if (!voiceStatesByGuild.has(gId)) {
                  voiceStatesByGuild.set(gId, new Map());
                }
                const gMap = voiceStatesByGuild.get(gId);
                if (msg.d.channel_id) {
                  gMap.set(String(msg.d.user_id), msg.d);
                } else {
                  gMap.delete(String(msg.d.user_id));
                }
              }

              if (String(msg.d.user_id) === this.userId) {
                if (msg.d.channel_id) {
                  cleanupTimers();
                  this.sessionId = String(msg.d.session_id);
                  this.voiceStateReceived = true;
                  console.log(`[${this.username}] ✅ VOICE_STATE_UPDATE: session_id=${this.sessionId}, channel_id=${msg.d.channel_id}`);
                  this._tryConnectVoiceWs();
                } else {
                  console.log(`[${this.username}] Disconnected from voice channel (channel_id is null)`);
                }
              }
            }

            if (msg.t === 'VOICE_SERVER_UPDATE' && msg.d) {
              const gId = msg.d.guild_id ? String(msg.d.guild_id) : null;
              if (!gId || gId === this.guildId) {
                this.voiceToken = msg.d.token;
                this.voiceEndpoint = msg.d.endpoint;
                console.log(`[${this.username}] Voice server update: endpoint=${this.voiceEndpoint}`);
                this._tryConnectVoiceWs();
              }
            }
            break;
          }
        }
      };

      this.gwWs.onerror = (e) => {
        console.error(`[${this.username}] Gateway WS error:`, e.message || 'unknown');
      };

      this.gwWs.onclose = (e) => {
        console.log(`[${this.username}] Gateway WS closed (${e.code})`);
        cleanupTimers();
        if (this.gwHb) { clearInterval(this.gwHb); this.gwHb = null; }
      };

      // Store resolver for when voice handshake is complete
      this._voiceReadyResolve = () => {
        cleanupTimers();
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(this);
        }
      };
      this._voiceReadyReject = (err) => {
        cleanupTimers();
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      };
    });
  }

  _sendGwHeartbeat() {
    if (this.gwWs && this.gwWs.readyState === 1) {
      this.gwWs.send(JSON.stringify({ op: 1, d: this.gwSeq }));
    }
  }

  _sendIdentify() {
    if (!this.gwWs || this.gwWs.readyState !== 1) return;
    const act = buildDiscordActivity('D4Hz WEB — High Frequency Audio', 'Voice Amplifier Active ⚡', Date.now());
    const payload = this.isBot
      ? {
          token: this.token.startsWith('Bot ') ? this.token : `Bot ${this.token}`,
          intents: 641, // Guilds (1) | GuildVoiceStates (128) | GuildMessages (512)
          properties: { os: 'Windows', browser: 'Discord Client', device: 'desktop' },
          presence: { status: 'online', since: 0, activities: [{ name: 'D4Hz', type: 0, state: 'Voice Amplifier Active ⚡' }], afk: false }
        }
      : {
          token: this.token.startsWith('Bot ') ? this.token.slice(4).trim() : this.token,
          capabilities: 16381,
          properties: {
            os: 'Windows', browser: 'Discord Client', device: '', system_locale: 'en-US',
            browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9175 Chrome/128.0.6613.186 Electron/32.2.5 Safari/537.36',
            browser_version: '32.2.5', os_version: '10.0.19045', release_channel: 'stable', client_build_number: 375492, client_event_source: null
          },
          presence: { status: 'online', since: 0, activities: [act], afk: false },
          compress: false,
          client_state: { guild_versions: {}, read_state_version: 0, user_guild_settings_version: -1 }
        };

    this.gwWs.send(JSON.stringify({ op: 2, d: payload }));
  }

  updatePresence(details, state, imageUrl = null) {
    if (!this.gwWs || this.gwWs.readyState !== 1) return;
    const act = buildDiscordActivity(details, state, this._presenceStart || Date.now(), imageUrl);
    this.gwWs.send(JSON.stringify({
      op: 3,
      d: {
        since: 0,
        activities: [act],
        status: 'online',
        afk: false
      }
    }));
  }

  _sendJoinVC() {
    if (!this.gwWs || this.gwWs.readyState !== 1) return;
    console.log(`[${this.username}] Sending Op 4 join Voice Channel: ${this.channelId}`);
    this.gwWs.send(JSON.stringify({
      op: 4,
      d: {
        guild_id: this.guildId,
        channel_id: this.channelId,
        self_mute: false,
        self_deaf: false
      }
    }));
  }

  // 2. Connect to Discord Voice Gateway WebSocket
  _tryConnectVoiceWs() {
    if (!this.voiceStateReceived || !this.voiceToken || !this.voiceEndpoint || this.voiceWs) {
      return;
    }

    const endpoint = this.voiceEndpoint.replace(/:443$/, '');
    const voiceWsUrl = `wss://${endpoint}/?v=8`;
    console.log(`[${this.username}] Connecting Voice WS: ${voiceWsUrl}`);

    try {
      this.voiceWs = new WebSocket(voiceWsUrl);
    } catch (e) {
      if (this._voiceReadyReject) this._voiceReadyReject(e);
      return;
    }

    this.voiceWs.onopen = () => {
      console.log(`[${this.username}] Voice WS connected`);
    };

    this.voiceWs.onmessage = (ev) => {
      // 1. Binary message from Discord Voice Gateway (Opcodes 25, 27, 28, 29, 30)
      if (typeof ev.data !== 'string') {
        const buffer = Buffer.isBuffer(ev.data) ? ev.data : Buffer.from(ev.data);
        if (buffer.length >= 3) {
          const seq = buffer.readUInt16BE(0);
          const op = buffer.readUInt8(2);
          const payload = buffer.subarray(3);
          this._handleVoiceBinaryMessage(op, payload, seq);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      switch (msg.op) {
        case 8: { // HELLO
          const interval = msg.d.heartbeat_interval;

          console.log(`[${this.username}] Voice HELLO (interval: ${interval}ms). Sending Op 0 Identify (server: ${this.guildId}, user: ${this.userId})...`);
          this.voiceWs.send(JSON.stringify({
            op: 0,
            d: {
              server_id: String(this.guildId || this.channelId),
              user_id: String(this.userId),
              session_id: String(this.sessionId),
              token: this.voiceToken,
              video: false,
              streams: [],
              max_dave_protocol_version: 1
            }
          }));

          // Start voice heartbeat interval AFTER identify is dispatched
          if (this.voiceHb) clearInterval(this.voiceHb);
          this.voiceHb = setInterval(() => this._sendVoiceHeartbeat(), interval);
          break;
        }
        case 2: { // READY
          this.ssrc = msg.d.ssrc;
          this.voiceIp = msg.d.ip;
          this.voicePort = msg.d.port;
          console.log(`[${this.username}] Voice READY: ssrc=${this.ssrc}, ip=${this.voiceIp}:${this.voicePort}`);
          this._startUdpDiscovery();
          break;
        }
        case 4: { // SESSION_DESCRIPTION
          this.secretKey = Buffer.from(msg.d.secret_key);
          this.voiceMode = msg.d.mode || 'aead_aes256_gcm_rtpsize';
          const daveVer = msg.d.dave_protocol_version !== undefined ? msg.d.dave_protocol_version : 0;
          console.log(`[${this.username}] Voice SESSION_DESCRIPTION: mode=${this.voiceMode}, dave_version=${daveVer}`);

          // Initialize DAVE session and dispatch MLS Key Package (Opcode 26)
          if (daveVer > 0 && DAVESession) {
            try {
              this.daveSession = new DAVESession(daveVer, String(this.userId), String(this.channelId));
              const keyPackage = this.daveSession.getSerializedKeyPackage();
              this._sendVoiceBinary(26, keyPackage);
              console.log(`[${this.username}] 🔑 Initialized DAVE session & sent MLS Key Package (${keyPackage.length} bytes, Op 26)`);
            } catch (err) {
              console.error(`[${this.username}] Failed to initialize DAVE session:`, err.message);
            }
          }

          // Send Op 5 Speaking (1 = Microphone, 4 = Priority)
          this._sendSpeaking(true);

          this.isReady = true;
          if (this._voiceReadyResolve) this._voiceReadyResolve();
          break;
        }
        case 5: { // SPEAKING event from other users
          break;
        }
        case 21: { // DAVE Protocol Prepare Transition
          const tId = msg.d && msg.d.transition_id;
          console.log(`[${this.username}] DAVE Prepare Transition (id: ${tId}, ver: ${msg.d && msg.d.protocol_version}). Acknowledging Op 23...`);
          if (this.voiceWs && this.voiceWs.readyState === 1 && tId != null) {
            this.voiceWs.send(JSON.stringify({ op: 23, d: { transition_id: tId } }));
          }
          break;
        }
        case 22: { // DAVE Execute Transition
          console.log(`[${this.username}] DAVE Execute Transition (id: ${msg.d && msg.d.transition_id})`);
          break;
        }
        case 24: { // DAVE Prepare Epoch
          const tId = msg.d && msg.d.transition_id;
          console.log(`[${this.username}] DAVE Prepare Epoch (id: ${tId}, epoch: ${msg.d && msg.d.epoch})...`);
          if (msg.d && msg.d.epoch === 1 && this.daveSession) {
            this.daveSession.reinit(msg.d.protocol_version || 1, String(this.userId), String(this.channelId));
            const kp = this.daveSession.getSerializedKeyPackage();
            this._sendVoiceBinary(26, kp);
            console.log(`[${this.username}] 🔑 Sent refreshed DAVE MLS Key Package (${kp.length} bytes)`);
          }
          if (this.voiceWs && this.voiceWs.readyState === 1 && tId != null) {
            this.voiceWs.send(JSON.stringify({ op: 23, d: { transition_id: tId } }));
          }
          break;
        }
        case 25: { // DAVE MLS External Sender
          console.log(`[${this.username}] DAVE MLS External Sender package received`);
          break;
        }
      }
    };

    this.voiceWs.onerror = (e) => {
      console.error(`[${this.username}] Voice WS error:`, e.message || 'unknown');
    };

    this.voiceWs.onclose = (e) => {
      console.log(`[${this.username}] Voice WS closed (${e.code})`);
      if (this.voiceHb) { clearInterval(this.voiceHb); this.voiceHb = null; }

      if (e.code === 4006 && !this.retried4006) {
        this.retried4006 = true;
        console.log(`[${this.username}] Received 4006 (Session not ready) — performing clean voice leave/rejoin...`);
        this.voiceWs = null;
        this.voiceToken = null;
        this.voiceStateReceived = false;
        if (this.daveSession) {
          try { this.daveSession.reset(); } catch (err) {}
          this.daveSession = null;
        }
        // Leave VC first on Gateway so Discord dispatches a fresh VOICE_SERVER_UPDATE
        if (this.gwWs && this.gwWs.readyState === 1 && this.guildId) {
          try {
            this.gwWs.send(JSON.stringify({
              op: 4,
              d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
            }));
          } catch (err) {}
        }
        setTimeout(() => this._sendJoinVC(), 400);
        return;
      }

      if (!this.isReady && this._voiceReadyReject) {
        const errorDesc = e.code === 4017 ? 'DAVE/E2EE required (4017)' : `Voice connection closed (${e.code})`;
        this._voiceReadyReject(new Error(errorDesc));
      }
    };
  }

  _handleVoiceBinaryMessage(op, payload, seq) {
    if (!this.daveSession) return;
    try {
      switch (op) {
        case 25: { // DaveMlsExternalSender
          console.log(`[${this.username}] 📥 Received DAVE MLS External Sender (${payload.length} bytes)`);
          this.daveSession.setExternalSender(payload);
          break;
        }
        case 27: { // DaveMlsProposals
          console.log(`[${this.username}] 📥 Received DAVE MLS Proposals (${payload.length} bytes)`);
          const optype = payload.readUInt8(0);
          const { commit, welcome } = this.daveSession.processProposals(
            optype,
            payload.subarray(1),
            [String(this.userId)]
          );
          if (commit) {
            const commitWelcome = welcome ? Buffer.concat([commit, welcome]) : commit;
            this._sendVoiceBinary(28, commitWelcome);
            console.log(`[${this.username}] 📤 Sent DAVE MLS Commit Welcome (Opcode 28)`);
          }
          break;
        }
        case 29: { // DaveMlsAnnounceCommitTransition
          console.log(`[${this.username}] 📥 Received DAVE MLS Announce Commit Transition (${payload.length} bytes)`);
          const { transitionId, success } = this.daveSession.processCommit(payload);
          if (success && transitionId !== 0 && this.voiceWs && this.voiceWs.readyState === 1) {
            this.voiceWs.send(JSON.stringify({ op: 23, d: { transition_id: transitionId } }));
            console.log(`[${this.username}] 📤 Sent DAVE Transition Ready (Opcode 23, id: ${transitionId})`);
          }
          break;
        }
        case 30: { // DaveMlsWelcome
          console.log(`[${this.username}] 📥 Received DAVE MLS Welcome (${payload.length} bytes)`);
          const { transitionId, success } = this.daveSession.processWelcome(payload);
          if (success && transitionId !== 0 && this.voiceWs && this.voiceWs.readyState === 1) {
            this.voiceWs.send(JSON.stringify({ op: 23, d: { transition_id: transitionId } }));
            console.log(`[${this.username}] 📤 Sent DAVE Transition Ready (Opcode 23, id: ${transitionId})`);
          }
          break;
        }
      }
    } catch (e) {
      console.warn(`[${this.username}] DAVE binary handler warning (op ${op}):`, e.message);
    }
  }

  _sendVoiceBinary(opcode, payload) {
    if (!this.voiceWs || this.voiceWs.readyState !== 1) return;
    try {
      const msg = Buffer.concat([Buffer.from([opcode]), payload]);
      this.voiceWs.send(msg);
    } catch (e) {
      console.error(`[${this.username}] Error sending voice binary message (op ${opcode}):`, e.message);
    }
  }

  _sendVoiceHeartbeat() {
    if (this.voiceWs && this.voiceWs.readyState === 1) {
      this.voiceWs.send(JSON.stringify({ op: 3, d: Date.now() }));
    }
  }

  _sendSpeaking(speaking = true) {
    if (!this.voiceWs || this.voiceWs.readyState !== 1) return;
    this.voiceWs.send(JSON.stringify({
      op: 5,
      d: {
        speaking: speaking ? 1 : 0, // 1 = Microphone
        delay: 0,
        ssrc: this.ssrc
      }
    }));
  }

  // 3. UDP IP Discovery and Protocol Selection
  _startUdpDiscovery() {
    try {
      this.udp = dgram.createSocket('udp4');
    } catch (e) {
      if (this._voiceReadyReject) this._voiceReadyReject(e);
      return;
    }

    this.udp.on('message', (msg) => {
      if (msg.length === 74) {
        // IP discovery response
        let nullIdx = -1;
        for (let i = 8; i < 72; i++) {
          if (msg[i] === 0) { nullIdx = i; break; }
        }
        const myIp = msg.toString('utf8', 8, nullIdx > 8 ? nullIdx : 72);
        const myPort = msg.readUInt16BE(72);
        console.log(`[${this.username}] UDP Discovery complete: ${myIp}:${myPort}`);

        // Send Op 1 Select Protocol
        if (this.voiceWs && this.voiceWs.readyState === 1) {
          this.voiceWs.send(JSON.stringify({
            op: 1,
            d: {
              protocol: 'udp',
              data: {
                address: myIp,
                port: myPort,
                mode: 'aead_aes256_gcm_rtpsize'
              }
            }
          }));
        }
      }
    });

    this.udp.on('error', (err) => {
      console.error(`[${this.username}] UDP error:`, err.message);
    });

    // Send 74-byte IP Discovery request
    const discoveryPacket = Buffer.alloc(74);
    discoveryPacket.writeUInt16BE(0x0001, 0); // Request
    discoveryPacket.writeUInt16BE(70, 2);     // Length
    discoveryPacket.writeUInt32BE(this.ssrc, 4); // SSRC
    this.udp.send(discoveryPacket, this.voicePort, this.voiceIp);
  }

  // 4. Send Opus audio frame via this account's UDP socket
  sendRtpOpus(opusBuffer) {
    if (!this.udp || !this.secretKey || !this.voicePort || !this.voiceIp) return;

    try {
      // 1. DAVE end-to-end encryption if active
      let audioPayload = opusBuffer;
      if (this.daveSession && this.daveSession.ready) {
        try {
          audioPayload = this.daveSession.encryptOpus(opusBuffer);
        } catch (e) {
          // fallback to raw opus
        }
      }

      // 2. 12-byte RTP header
      const header = Buffer.alloc(12);
      header[0] = 0x80; // Version 2
      header[1] = 0x78; // Payload type 120 (Opus)
      header.writeUInt16BE(this.seq & 0xFFFF, 2);
      this.seq = (this.seq + 1) & 0xFFFF;
      header.writeUInt32BE(this.timestamp >>> 0, 4);
      this.timestamp = (this.timestamp + 960) >>> 0; // 20ms @ 48kHz
      header.writeUInt32BE(this.ssrc >>> 0, 8);

      // 3. Transport encryption (AES-256-GCM with 4-byte counter)
      const nonce = Buffer.alloc(12, 0);
      nonce.writeUInt32LE(this.packetCounter >>> 0, 0);

      const cipher = crypto.createCipheriv('aes-256-gcm', this.secretKey, nonce);
      cipher.setAAD(header);
      const encrypted = Buffer.concat([cipher.update(audioPayload), cipher.final()]);
      const authTag = cipher.getAuthTag();

      const counterBuf = Buffer.alloc(4);
      counterBuf.writeUInt32LE(this.packetCounter >>> 0, 0);
      this.packetCounter = (this.packetCounter + 1) >>> 0;

      const rtpPacket = Buffer.concat([header, encrypted, authTag, counterBuf]);
      this.udp.send(rtpPacket, this.voicePort, this.voiceIp);
    } catch (e) {
      // Silently discard packet encryption drop
    }
  }

  destroy() {
    this.isReady = false;
    if (this._joinRetryInterval) { clearInterval(this._joinRetryInterval); this._joinRetryInterval = null; }
    if (this.gwHb) { clearInterval(this.gwHb); this.gwHb = null; }
    if (this.voiceHb) { clearInterval(this.voiceHb); this.voiceHb = null; }
    if (this.daveSession) {
      try { this.daveSession.reset(); } catch (e) {}
      this.daveSession = null;
    }

    // Leave VC on Gateway
    if (this.gwWs && this.gwWs.readyState === 1 && this.guildId) {
      try {
        this.gwWs.send(JSON.stringify({
          op: 4,
          d: { guild_id: this.guildId, channel_id: null, self_mute: false, self_deaf: false }
        }));
      } catch (e) {}
    }

    if (this.voiceWs) { try { this.voiceWs.close(1000); } catch (e) {} this.voiceWs = null; }
    if (this.gwWs) { try { this.gwWs.close(1000); } catch (e) {} this.gwWs = null; }
    if (this.udp) { try { this.udp.close(); } catch (e) {} this.udp = null; }
    console.log(`[${this.username}] Client destroyed and disconnected`);
  }
}

function maskToken(token) {
  if (!token || typeof token !== 'string') return '***';
  return token.length > 8 ? `${token.slice(0, 6)}...***` : '***';
}


// ══════════════════════════════════════════════════════════
//  LIVE MICROPHONE & SOUNDPAD DISCORD BROADCASTER ENGINE
// ══════════════════════════════════════════════════════════
const micQueue = [];
let micStreamBuffer = Buffer.alloc(0);
let micBroadcastTimer = null;
let micSpeakingActive = false;
let micIdleTicks = 0;
let soundpadTimer = null;

function ensureMicBroadcastLoop() {
  if (micBroadcastTimer) return;
  micBroadcastTimer = setInterval(() => {
    if (micQueue.length > 0) {
      if (!micSpeakingActive) {
        micSpeakingActive = true;
        for (const [, client] of activeClients) {
          if (client.isReady) client._sendSpeaking(true);
        }
      }
      micIdleTicks = 0;
      // If queue is larger than 12 frames (>240ms), burst slightly to keep latency near real-time
      const framesToSend = micQueue.length > 12 ? 2 : 1;
      for (let f = 0; f < framesToSend && micQueue.length > 0; f++) {
        const frame = micQueue.shift();
        for (const [, client] of activeClients) {
          if (client.isReady) {
            client.sendRtpOpus(frame);
          }
        }
        if (currentSession) currentSession.packetsBroadcast = (currentSession.packetsBroadcast || 0) + 1;
      }
    } else {
      micIdleTicks++;
      // After ~240ms of silence (12 ticks of 20ms), deactivate speaking indicator
      if (micSpeakingActive && micIdleTicks > 12) {
        micSpeakingActive = false;
        for (const [, client] of activeClients) {
          if (client.isReady) client._sendSpeaking(false);
        }
      }
    }
  }, 20);
}

function stopSoundpad() {
  if (soundpadTimer) {
    clearInterval(soundpadTimer);
    soundpadTimer = null;
  }
}

function extractOpusFromWebMStream(buf) {
  const frames = [];
  let i = 0;
  let lastValidEnd = 0;

  while (i <= buf.length - 4) {
    if (buf[i] === 0xA3) { // SimpleBlock
      let lenByte = buf[i + 1];
      let len = 0, lenLen = 0;
      if (lenByte & 0x80) {
        len = lenByte & 0x7F;
        lenLen = 1;
      } else if (lenByte & 0x40) {
        if (i + 2 >= buf.length) break;
        len = ((lenByte & 0x3F) << 8) | buf[i + 2];
        lenLen = 2;
      } else if (lenByte & 0x20) {
        if (i + 3 >= buf.length) break;
        len = ((lenByte & 0x1F) << 16) | (buf[i + 2] << 8) | buf[i + 3];
        lenLen = 3;
      } else if (lenByte & 0x10) {
        if (i + 4 >= buf.length) break;
        len = ((lenByte & 0x0F) << 24) | (buf[i + 2] << 16) | (buf[i + 3] << 8) | buf[i + 4];
        lenLen = 4;
      }

      // Sanity check length for an Opus frame (must be at least 4 bytes and at most 2048 bytes)
      if (lenLen > 0 && len >= 4 && len <= 2048) {
        const blockStart = i + 1 + lenLen;
        const blockEnd = blockStart + len;
        if (blockEnd > buf.length) {
          // Incomplete SimpleBlock at end of buffer; wait for next chunk
          break;
        }

        // Parse track number (VINT)
        let trackLen = 1;
        const trackByte = buf[blockStart];
        if (!(trackByte & 0x80)) {
          if (trackByte & 0x40) trackLen = 2;
          else if (trackByte & 0x20) trackLen = 3;
        }

        // SimpleBlock header: TrackNum (trackLen) + Timecode (2) + Flags (1)
        const headerSize = trackLen + 2 + 1;
        if (len > headerSize) {
          const flags = buf[blockStart + trackLen + 2];
          const lacing = (flags & 0x06) >> 1;

          if (lacing === 0) { // No lacing (standard for Opus frames in WebM)
            const opusData = buf.subarray(blockStart + headerSize, blockEnd);
            if (opusData.length > 0) frames.push(opusData);
          } else {
            // Laced frames
            const numFrames = buf[blockStart + headerSize] + 1;
            let offset = blockStart + headerSize + 1;
            const frameSizes = [];
            let totalLacedSize = 0;

            if (lacing === 1) { // Xiph lacing
              for (let f = 0; f < numFrames - 1; f++) {
                let size = 0;
                while (offset < blockEnd) {
                  const b = buf[offset++];
                  size += b;
                  if (b < 255) break;
                }
                frameSizes.push(size);
                totalLacedSize += size;
              }
              frameSizes.push((blockEnd - offset) - totalLacedSize);
            } else if (lacing === 3) { // EBML lacing
              let prevSize = 0;
              for (let f = 0; f < numFrames - 1; f++) {
                let sizeByte = buf[offset++];
                let sLen = 0;
                if (sizeByte & 0x80) { sLen = sizeByte & 0x7F; }
                else if (sizeByte & 0x40) { sLen = ((sizeByte & 0x3F) << 8) | buf[offset++]; }
                prevSize += sLen;
                frameSizes.push(prevSize);
                totalLacedSize += prevSize;
              }
              frameSizes.push((blockEnd - offset) - totalLacedSize);
            }

            for (const sz of frameSizes) {
              if (sz > 0 && offset + sz <= blockEnd) {
                frames.push(buf.subarray(offset, offset + sz));
                offset += sz;
              }
            }
          }
        }

        i = blockEnd;
        lastValidEnd = blockEnd;
        continue;
      }
    }
    i++;
  }

  const remaining = buf.subarray(lastValidEnd);
  return { frames, remaining: remaining.length > 65536 ? Buffer.alloc(0) : remaining };
}

function extractOpusFromWebM(buf) {
  const res = extractOpusFromWebMStream(buf);
  return res.frames;
}

function handleIncomingMicAudio(buf) {
  if (!buf || !buf.length) return;
  ensureMicBroadcastLoop();

  const combined = micStreamBuffer.length > 0 ? Buffer.concat([micStreamBuffer, buf]) : buf;
  const { frames, remaining } = extractOpusFromWebMStream(combined);
  micStreamBuffer = remaining;

  if (frames.length > 0) {
    for (const frame of frames) {
      if (frame && frame.length > 0) {
        micQueue.push(frame);
      }
    }
    if (micQueue.length > 25) {
      micQueue.splice(0, micQueue.length - 20);
    }
  }
}

function playSoundpadOpus(frames) {
  stopSoundpad();
  if (!frames || !frames.length) return;
  console.log(`[Soundpad] Broadcasting ${frames.length} Opus frames to ${activeClients.size} voice clients...`);

  for (const [, client] of activeClients) {
    client._sendSpeaking(true);
  }

  let idx = 0;
  soundpadTimer = setInterval(() => {
    if (idx >= frames.length || activeClients.size === 0) {
      stopSoundpad();
      for (const [, client] of activeClients) {
        if (!micSpeakingActive) client._sendSpeaking(false);
      }
      console.log('[Soundpad] Playback finished');
      return;
    }
    const frame = frames[idx];
    for (const [, client] of activeClients) {
      if (client.isReady) {
        client.sendRtpOpus(frame);
      }
    }
    idx++;
  }, 20);
}

// ══════════════════════════════════════════════════════════
//  HTTP SERVER & REST / RELAY ENDPOINTS
// ══════════════════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  // Enforce local network security origin policy (localhost or local LAN for mobile)
  const origin = req.headers.origin;
  const isLocalOrigin = !origin || origin === 'null' ||
    origin.includes('localhost') || origin.includes('127.0.0.1') ||
    origin.includes('192.168.') || origin.includes('10.') || origin.includes('172.');
  if (!isLocalOrigin) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Forbidden: Origin blocked under Discord Security Guidelines' }));
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Captcha-Key, X-Captcha-Rqtoken');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, 'http://localhost');

  // Static web app serving for mobile & desktop browsers
  if (req.method === 'GET' && (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html')) {
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }
  if (req.method === 'GET' && (reqUrl.pathname === '/DEATH.gif' || reqUrl.pathname === '/death.gif')) {
    const filePath = path.join(__dirname, 'DEATH.gif');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // 1. GET /invite-info?code=...
  if (req.method === 'GET' && reqUrl.pathname === '/invite-info') {
    const code = reqUrl.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing code' }));
      return;
    }
    const cleanCode = code.replace(/^https?:\/\/(www\.)?(discord\.gg\/|discord(app)?\.com\/invite\/)/i, '').trim();
    try {
      const dRes = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(cleanCode)}?with_counts=true`);
      const data = await dRes.json();
      res.writeHead(dRes.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // 1b. POST /join-invite — Join server via Discord invite with rate-limiting backoff & member onboarding
  if (req.method === 'POST' && (reqUrl.pathname === '/join-invite' || req.url === '/join-invite')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { accounts, inviteCode } = JSON.parse(body || '{}');
        const cleanCode = (inviteCode || '').replace(/^https?:\/\/(www\.)?(discord\.gg\/|discord(app)?\.com\/invite\/)/i, '').trim();
        const results = [];

        for (const acc of (accounts || [])) {
          try {
            let res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(cleanCode)}`, {
              method: 'POST',
              headers: {
                'Authorization': acc.token,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({})
            });

            if (res.status === 429) {
              const retryAfter = parseFloat(res.headers.get('retry-after') || '2');
              await new Promise(r => setTimeout(r, (retryAfter * 1000) + 200));
              res = await fetch(`https://discord.com/api/v10/invites/${encodeURIComponent(cleanCode)}`, {
                method: 'POST',
                headers: { 'Authorization': acc.token, 'Content-Type': 'application/json' },
                body: JSON.stringify({})
              });
            }

            const data = await res.json();

            // Handle member onboarding / verification rules if guild requires it
            if (res.ok && data.guild_id) {
              let subRes = await fetch(`https://discord.com/api/v10/guilds/${data.guild_id}/onboarding`, {
                headers: { 'Authorization': acc.token }
              });
              if (subRes.status === 429) {
                const subRetry = parseFloat(subRes.headers.get('retry-after') || '1.5');
                await new Promise(r => setTimeout(r, (subRetry * 1000) + 100));
                subRes = await fetch(`https://discord.com/api/v10/guilds/${data.guild_id}/onboarding`, {
                  headers: { 'Authorization': acc.token }
                });
              }
            }

            results.push({
              username: acc.username,
              ok: res.ok,
              token: maskToken(acc.token),
              guild: data.guild || null
            });
          } catch (err) {
            results.push({
              username: acc.username,
              ok: false,
              token: maskToken(acc.token),
              error: err.message
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /play-sound — Broadcast soundpad Opus frames to all connected VC clients
  if (req.method === 'POST' && (reqUrl.pathname === '/play-sound' || req.url === '/play-sound')) {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const fullBuf = Buffer.concat(chunks);
        let frames = [];
        // Check if payload is JSON with base64 frames or raw WebM
        if (fullBuf[0] === 0x7B) { // '{'
          const data = JSON.parse(fullBuf.toString('utf8'));
          if (Array.isArray(data.frames)) {
            frames = data.frames.map(f => Buffer.from(f, 'base64'));
          } else if (data.webm) {
            frames = extractOpusFromWebM(Buffer.from(data.webm, 'base64'));
          }
        } else {
          // Direct WebM binary
          frames = extractOpusFromWebM(fullBuf);
        }

        if (frames.length > 0) {
          playSoundpadOpus(frames);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, framesPlayed: frames.length }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'No valid Opus audio frames found' }));
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /stop-sound — Stop soundpad playback
  if (req.method === 'POST' && (reqUrl.pathname === '/stop-sound' || req.url === '/stop-sound')) {
    stopSoundpad();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /mic-chunk — Live microphone audio chunk streaming
  if (req.method === 'POST' && (reqUrl.pathname === '/mic-chunk' || req.url === '/mic-chunk')) {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const fullBuf = Buffer.concat(chunks);
        handleIncomingMicAudio(fullBuf);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: micQueue.length }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /mic-speaking — Push-to-talk and speaking state sync
  if (req.method === 'POST' && (reqUrl.pathname === '/mic-speaking' || req.url === '/mic-speaking')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        let speaking = true;
        try {
          const parsed = JSON.parse(body || '{}');
          speaking = typeof parsed.speaking === 'boolean' ? parsed.speaking : true;
        } catch (e) {
          speaking = !body.includes('false');
        }
        micSpeakingActive = !!speaking;
        for (const [, client] of activeClients) {
          if (client.isReady) client._sendSpeaking(micSpeakingActive);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, speaking: micSpeakingActive }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /start — start voice relay for microphone broadcasting
  if (req.method === 'POST' && (reqUrl.pathname === '/start' || req.url === '/start')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const cfg = JSON.parse(body);
        const result = await startVoiceRelay(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // POST /stop — stop all voice connections
  if (req.method === 'POST' && (reqUrl.pathname === '/stop' || req.url === '/stop')) {
    await stopAllClients();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /status — Live amplifier & microphone status
  if (req.method === 'GET' && (reqUrl.pathname === '/status' || req.url === '/status')) {
    const clientsList = [];
    for (const [, c] of activeClients) {
      clientsList.push({
        username: c.username,
        isBot: c.isBot,
        isReady: c.isReady,
        ssrc: c.ssrc
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      active: activeClients.size,
      micActive: micSpeakingActive,
      queueSize: micQueue.length,
      packetsBroadcast: currentSession ? currentSession.packetsBroadcast : 0,
      clients: clientsList
    }));
    return;
  }

  // 8. GET /DEATH.gif — Serve local DEATH.gif file
  if (req.method === 'GET' && (reqUrl.pathname === '/DEATH.gif' || req.url === '/DEATH.gif')) {
    const gifPath = path.join(__dirname, 'DEATH.gif');
    if (fs.existsSync(gifPath)) {
      res.writeHead(200, {
        'Content-Type': 'image/gif',
        'Cache-Control': 'public, max-age=86400'
      });
      fs.createReadStream(gifPath).pipe(res);
    } else {
      res.writeHead(302, { 'Location': DEFAULT_DEATH_GIF_URL });
      res.end();
    }
    return;
  }

  // 9. POST /update-activity — Update Discord Rich Presence and Profile Activity
  if (req.method === 'POST' && (reqUrl.pathname === '/update-activity' || req.url === '/update-activity')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { details, state, imageUrl } = JSON.parse(body || '{}');
        for (const [, c] of activeClients) {
          c.updatePresence(details, state, imageUrl);
        }
        updateLocalDiscordIpc(details, state, imageUrl);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, details, state }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

// ══════════════════════════════════════════════════════════
//  NATIVE WEBSOCKET UPGRADE (ZERO DEPENDENCY RFC-6455)
// ══════════════════════════════════════════════════════════
function handleMicWsUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`
  ];

  socket.write(headers.join('\r\n') + '\r\n\r\n');
  console.log('[Relay] 🎙️ Live Microphone WebSocket stream connected!');

  let frameBuffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);

    while (frameBuffer.length >= 2) {
      const b0 = frameBuffer[0];
      const b1 = frameBuffer[1];
      const opcode = b0 & 0x0F;
      const isMasked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7F;
      let offset = 2;

      if (payloadLen === 126) {
        if (frameBuffer.length < 4) break;
        payloadLen = frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (frameBuffer.length < 10) break;
        payloadLen = Number(frameBuffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (frameBuffer.length < offset + maskLen + payloadLen) {
        break; // Wait for full frame
      }

      let payload = frameBuffer.subarray(offset + maskLen, offset + maskLen + payloadLen);

      if (isMasked) {
        const mask = frameBuffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let j = 0; j < payloadLen; j++) {
          unmasked[j] = payload[j] ^ mask[j % 4];
        }
        payload = unmasked;
      }

      frameBuffer = frameBuffer.subarray(offset + maskLen + payloadLen);

      if (opcode === 8) { // Close
        socket.end();
        break;
      } else if (opcode === 9) { // Ping
        const pong = Buffer.alloc(2);
        pong[0] = 0x8A;
        pong[1] = 0x00;
        socket.write(pong);
      } else if (opcode === 1) { // Text JSON
        try {
          const txt = payload.toString('utf8');
          const data = JSON.parse(txt);
          if (typeof data.speaking === 'boolean') {
            micSpeakingActive = data.speaking;
            for (const [, client] of activeClients) {
              if (client.isReady) client._sendSpeaking(micSpeakingActive);
            }
          }
        } catch (e) {}
      } else if (opcode === 2) { // Binary Opus chunk
        handleIncomingMicAudio(payload);
      }
    }
  });

  socket.on('close', () => {
    console.log('[Relay] 🎙️ Live Microphone WebSocket stream disconnected');
  });

  socket.on('error', () => {
    socket.destroy();
  });
}

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, 'http://localhost');
  if (reqUrl.pathname === '/mic' || reqUrl.pathname === '/mic-stream') {
    handleMicWsUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// ══════════════════════════════════════════════════════════
//  VOICE RELAY MANAGEMENT & LIVE MICROPHONE BROADCAST
// ══════════════════════════════════════════════════════════
async function stopAllClients() {
  stopSoundpad();
  if (micBroadcastTimer) {
    clearInterval(micBroadcastTimer);
    micBroadcastTimer = null;
  }
  micQueue.length = 0;
  micStreamBuffer = Buffer.alloc(0);
  micSpeakingActive = false;

  for (const [, client] of activeClients) {
    try {
      client.updatePresence('D4Hz WEB — High Frequency Audio', 'Voice Amplifier Idle');
      client.destroy();
    } catch (e) {}
  }
  activeClients.clear();
  currentSession = null;
  updateLocalDiscordIpc('D4Hz WEB — High Frequency Audio', 'Voice Amplifier Idle');
  console.log('[Relay] All clients disconnected and stopped');
}

async function startVoiceRelay(cfg) {
  await stopAllClients();

  const { accounts, guildId, channelId } = cfg;
  if (!accounts || !accounts.length || !guildId || !channelId) {
    throw new Error('Missing required configuration (accounts, guildId, channelId)');
  }

  const cleanChannelId = String(channelId).trim();
  let cleanGuildId = String(guildId).trim();

  // 1. Channel Pre-Validation & Auto-Correction via Discord REST API
  let channelVerified = false;
  for (const acc of accounts) {
    try {
      const authHeader = acc.isBot
        ? (acc.token.startsWith('Bot ') ? acc.token : `Bot ${acc.token}`)
        : (acc.token.startsWith('Bot ') ? acc.token.slice(4).trim() : acc.token);
      const chRes = await fetch(`https://discord.com/api/v10/channels/${cleanChannelId}`, {
        headers: { 'Authorization': authHeader }
      });

      if (chRes.ok) {
        const chData = await chRes.json();
        console.log(`[Relay] 🔍 Channel ${cleanChannelId} verified: "${chData.name}" (type ${chData.type}, guild ${chData.guild_id})`);

        if (chData.type !== 2 && chData.type !== 13) {
          const typeNames = { 0: 'Text Channel', 4: 'Category', 5: 'Announcement', 15: 'Forum' };
          const typeStr = typeNames[chData.type] || `type ${chData.type}`;
          throw new Error(`Channel "${chData.name}" is a ${typeStr}, not a Voice Channel! Please enter a Voice Channel ID.`);
        }

        if (chData.guild_id && String(chData.guild_id) !== cleanGuildId) {
          console.log(`[Relay] 🔄 Auto-corrected Guild ID from ${cleanGuildId} to ${chData.guild_id} (matches VC location)`);
          cleanGuildId = String(chData.guild_id);
        }
        channelVerified = true;
        break;
      } else if (chRes.status === 404) {
        throw new Error(`Voice Channel ID "${cleanChannelId}" not found (HTTP 404). Please verify that the channel ID is correct.`);
      } else if (chRes.status === 403) {
        console.warn(`[Relay] ⚠️ Account ${acc.username || 'unknown'} lacks VIEW_CHANNEL permission for channel ${cleanChannelId}`);
      }
    } catch (e) {
      if (e.message.includes('not a Voice Channel') || e.message.includes('not found')) throw e;
      console.warn(`[Relay] Channel pre-check note:`, e.message);
    }
  }

  currentSession = {
    guildId: cleanGuildId,
    channelId: cleanChannelId,
    packetsBroadcast: 0
  };

  console.log(`[Relay] 🎙️ Starting live microphone voice broadcast on guild ${cleanGuildId}, VC ${cleanChannelId} for ${accounts.length} accounts...`);
  ensureMicBroadcastLoop();

  const connectedList = [];

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    try {
      const client = new NativeVoiceClient(acc.token, acc.isBot, acc.username);

      // Connect gateway and voice
      await client.connectGateway(cleanGuildId, cleanChannelId);
      activeClients.set(acc.token, client);
      connectedList.push({ username: acc.username, ok: true, token: maskToken(acc.token) });
      console.log(`[Relay] ✅ [${acc.username || i}] fully connected to VC and ready to broadcast mic!`);
    } catch (err) {
      console.error(`[Relay] ❌ [${acc.username || i}] failed:`, err.message);
      connectedList.push({ username: acc.username, ok: false, token: maskToken(acc.token), error: err.message });
    }

    if (i < accounts.length - 1) await new Promise(r => setTimeout(r, 1800 + Math.random() * 800)); // Anti-violation human stagger
  }

  // Update Discord Profile Activity with DEATH.gif for all connected voice clients and local desktop
  const actDetails = 'Microphone Broadcast Active 🎙️';
  const actState = `Broadcasting Voice in VC ⚡`;
  updateLocalDiscordIpc(actDetails, actState);
  for (const [, c] of activeClients) {
    try { c.updatePresence(actDetails, actState); } catch (e) {}
  }

  return {
    ok: true,
    connected: activeClients.size,
    total: accounts.length,
    results: connectedList
  };
}

process.on('SIGINT', async () => {
  await stopAllClients();
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`====================================================`);
  console.log(`🚀 D4Hz WEB Voice Relay Backend active on http://127.0.0.1:${PORT}`);
  console.log(`⚡ Zero-dependency native Node 24 voice client engine`);
  console.log(`🎙️ Live Microphone Streaming & Multi-Account Broadcast Enabled`);
  console.log(`====================================================`);
});
