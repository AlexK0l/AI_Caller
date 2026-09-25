// Voximplant VoxEngine scenario for AI_Caller option B.
// Flow: PSTN call <-> VoxEngine WebSocket <-> Node.js <-> OpenAI Realtime.
//
// Bind this scenario to the routing rule whose ID is VOXIMPLANT_RULE_ID.

require(Modules.WebSocket);

let call = null;
let ws = null;
let terminating = false;

function sendEvent(payload) {
  if (ws && ws.readyState === WebSocketReadyState.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function terminateSoon() {
  if (terminating) return;
  terminating = true;
  setTimeout(() => VoxEngine.terminate(), 300);
}

function finish(type, reason, message) {
  sendEvent({
    type,
    reason: reason || null,
    message: message || null,
    callId: call ? call.id() : null,
  });
  terminateSoon();
}

VoxEngine.addEventListener(AppEvents.Started, () => {
  let data;
  try {
    data = JSON.parse(VoxEngine.customData());
  } catch (error) {
    Logger.write('Invalid custom data: ' + error);
    VoxEngine.terminate();
    return;
  }

  if (!data.to || !data.from || !data.ws) {
    Logger.write('Required custom data is missing');
    VoxEngine.terminate();
    return;
  }

  ws = VoxEngine.createWebSocket(data.ws, {
    privacy: true,
    statistics: true,
  });

  ws.addEventListener(WebSocketEvents.OPEN, () => {
    sendEvent({ type: 'bridge_ready' });

    call = VoxEngine.callPSTN(data.to, data.from);

    call.addEventListener(CallEvents.Connected, () => {
      sendEvent({ type: 'connected', callId: call.id() });

      // Caller -> Node.js/OpenAI. ULAW keeps the telephony 8 kHz stream compressed
      // and matches OpenAI Realtime g711_ulaw, so no resampling is needed.
      call.sendMediaTo(ws, {
        encoding: WebSocketAudioEncoding.ULAW,
        tag: 'caller',
      });

      // Node.js/OpenAI -> caller.
      ws.sendMediaTo(call, {
        encoding: WebSocketAudioEncoding.ULAW,
        tag: 'assistant',
      });
    });

    call.addEventListener(CallEvents.Failed, (event) => {
      finish('failed', event.code || 'failed', event.reason || null);
    });

    call.addEventListener(CallEvents.Disconnected, (event) => {
      finish('disconnected', event.code || 'completed', event.reason || null);
    });
  });

  ws.addEventListener(WebSocketEvents.MESSAGE, (event) => {
    try {
      const message = JSON.parse(event.text);
      if (message.type === 'hangup' && call) {
        call.hangup();
      } else if (message.type === 'clear_audio') {
        ws.clearMediaBuffer({ tag: 'assistant' });
      }
    } catch (error) {
      Logger.write('Control message error: ' + error);
    }
  });

  ws.addEventListener(WebSocketEvents.ERROR, () => {
    if (call) call.hangup();
    terminateSoon();
  });

  ws.addEventListener(WebSocketEvents.CLOSE, () => {
    if (call) call.hangup();
    terminateSoon();
  });
});
