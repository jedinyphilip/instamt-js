/** Tiny log writer for the in-page console pane. */
export class LogPane {
  constructor(private readonly el: HTMLElement) {}

  info(text: string): void {
    this.append(text, 'log-info');
  }
  ok(text: string): void {
    this.append(text, 'log-ok');
  }
  err(text: string): void {
    this.append(text, 'log-err');
  }
  raw(text: string): void {
    this.append(text);
  }

  private append(text: string, cls?: string): void {
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text + '\n';
    this.el.appendChild(span);
    this.el.scrollTop = this.el.scrollHeight;
  }

  clear(): void {
    this.el.textContent = '';
  }
}
