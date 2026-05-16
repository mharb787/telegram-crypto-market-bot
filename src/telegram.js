export class TelegramBot {
  constructor({ token, chatId, dryRun = false }) {
    this.token = token;
    this.chatId = chatId;
    this.dryRun = dryRun;
    this.offset = 0;
  }

  apiUrl(method) {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async sendMessage(text, options = {}) {
    if (this.dryRun || !this.token || !this.chatId) {
      console.log("\n--- TELEGRAM MESSAGE ---\n");
      console.log(text);
      return;
    }

    const response = await fetch(this.apiUrl("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...options
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
    }
  }

  async sendPhoto(buffer, caption, options = {}) {
    if (this.dryRun || !this.token || !this.chatId) {
      console.log("\n--- TELEGRAM PHOTO ---\n");
      console.log(caption);
      return;
    }

    const form = new FormData();
    form.set("chat_id", String(this.chatId));
    form.set("photo", new Blob([buffer], { type: "image/png" }), "recommendation-chart.png");
    form.set("caption", caption);
    form.set("parse_mode", "HTML");
    for (const [key, value] of Object.entries(options)) {
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    const response = await fetch(this.apiUrl("sendPhoto"), {
      method: "POST",
      body: form
    });

    if (!response.ok) {
      throw new Error(`Telegram sendPhoto failed: ${response.status} ${await response.text()}`);
    }
  }

  async answerCallbackQuery(callbackQueryId, text = "") {
    if (this.dryRun || !this.token) return;
    const response = await fetch(this.apiUrl("answerCallbackQuery"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram answerCallbackQuery failed: ${response.status} ${await response.text()}`);
    }
  }

  async poll({ onMessage, onCallback }) {
    if (!this.token) return;
    const response = await fetch(this.apiUrl(`getUpdates?timeout=25&offset=${this.offset}`));
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    for (const update of payload.result ?? []) {
      this.offset = update.update_id + 1;
      const message = update.message?.text;
      if (message && onMessage) await onMessage(message, update.message);
      if (update.callback_query && onCallback) await onCallback(update.callback_query);
    }
  }
}
