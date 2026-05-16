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

  async poll(handler) {
    if (!this.token) return;
    const response = await fetch(this.apiUrl(`getUpdates?timeout=25&offset=${this.offset}`));
    if (!response.ok) {
      throw new Error(`Telegram getUpdates failed: ${response.status} ${await response.text()}`);
    }
    const payload = await response.json();
    for (const update of payload.result ?? []) {
      this.offset = update.update_id + 1;
      const message = update.message?.text;
      if (message) await handler(message, update.message);
    }
  }
}
