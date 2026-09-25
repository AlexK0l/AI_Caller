import crypto from 'node:crypto';

const API_URL = 'https://api.voximplant.com/platform_api/StartScenarios/';

function toWebSocketBaseUrl(publicBaseUrl) {
  const url = new URL(publicBaseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

export class VoximplantProvider {
  constructor({ accountId, apiKey, ruleId, fromNumber, mediaSecret, publicBaseUrl }) {
    this.accountId = String(accountId);
    this.apiKey = apiKey;
    this.ruleId = String(ruleId);
    this.fromNumber = fromNumber;
    this.mediaSecret = mediaSecret;
    this.publicBaseUrl = publicBaseUrl.replace(/\/$/, '');
  }

  signMediaToken(token) {
    return crypto
      .createHmac('sha256', this.mediaSecret)
      .update(token)
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }

  buildMediaUrl(token) {
    const url = toWebSocketBaseUrl(this.publicBaseUrl);
    url.pathname = `${url.pathname}/voximplant/media/${token}`.replace(/\/+/g, '/');
    url.searchParams.set('sig', this.signMediaToken(token));
    return url.toString();
  }

  async createCall(callContext) {
    const scenarioData = JSON.stringify({
      t: callContext.token,
      to: callContext.to,
      from: this.fromNumber,
      ws: this.buildMediaUrl(callContext.token),
    });

    // VoxEngine script_custom_data is limited to 200 bytes.
    if (Buffer.byteLength(scenarioData, 'utf8') > 200) {
      const error = new Error('voximplant_script_custom_data_too_long');
      error.statusCode = 500;
      throw error;
    }

    const body = new URLSearchParams({
      account_id: this.accountId,
      api_key: this.apiKey,
      rule_id: this.ruleId,
      script_custom_data: scenarioData,
    });

    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || Number(data.result) !== 1) {
      const error = new Error(
        data.error?.msg || data.error?.message || data.message || 'voximplant_start_scenario_failed',
      );
      error.statusCode = response.status >= 400 ? response.status : 502;
      error.providerResponse = data;
      throw error;
    }

    return {
      status: 'queued',
      providerSessionId: String(data.call_session_history_id || ''),
      mediaSessionAccessUrl: data.media_session_access_secure_url || null,
    };
  }

  async hangup(callContext) {
    const socket = callContext.bridgeSocket;
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'hangup' }));
      return true;
    }
    return false;
  }
}
