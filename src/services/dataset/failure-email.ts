import net from "node:net";
import { pushAppNotification } from "@/services/dataset/notifications-store";

function env(name: string) {
  return process.env[name]?.trim() || "";
}

export function isFailureEmailConfigured() {
  return Boolean(
    env("ARA_ALERT_SMTP_HOST") &&
      env("ARA_ALERT_TO") &&
      env("ARA_ALERT_FROM")
  );
}

/**
 * Minimal SMTP sender (no dependency). Used for failure alerts only.
 * Configure: ARA_ALERT_SMTP_HOST, ARA_ALERT_SMTP_PORT, ARA_ALERT_SMTP_USER,
 * ARA_ALERT_SMTP_PASS, ARA_ALERT_FROM, ARA_ALERT_TO
 */
export async function sendFailureEmailAlert(input: {
  subject: string;
  body: string;
  toOverride?: string;
}): Promise<{ sent: boolean; error?: string }> {
  const to = input.toOverride?.trim() || env("ARA_ALERT_TO");
  if (!env("ARA_ALERT_SMTP_HOST") || !to || !env("ARA_ALERT_FROM")) {
    return { sent: false, error: "SMTP alert env vars not configured." };
  }

  const host = env("ARA_ALERT_SMTP_HOST");
  const port = Number(env("ARA_ALERT_SMTP_PORT") || "587");
  const user = env("ARA_ALERT_SMTP_USER");
  const pass = env("ARA_ALERT_SMTP_PASS");
  const from = env("ARA_ALERT_FROM");

  try {
    await smtpSend({
      host,
      port,
      user: user || undefined,
      pass: pass || undefined,
      from,
      to,
      subject: input.subject,
      body: input.body,
    });
    return { sent: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "SMTP send failed.";
    await pushAppNotification({
      kind: "dataset_sync_failed",
      title: "Failure email alert could not be sent",
      body: message,
      href: "/dataset",
    }).catch(() => undefined);
    return { sent: false, error: message };
  }
}

async function smtpSend(options: {
  host: string;
  port: number;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  subject: string;
  body: string;
}) {
  const socket = net.createConnection({
    host: options.host,
    port: options.port,
  });

  const read = () =>
    new Promise<string>((resolve, reject) => {
      const onData = (buf: Buffer) => {
        cleanup();
        resolve(buf.toString("utf8"));
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        socket.off("data", onData);
        socket.off("error", onError);
      };
      socket.on("data", onData);
      socket.on("error", onError);
    });

  const write = async (line: string) => {
    socket.write(`${line}\r\n`);
    return read();
  };

  try {
    await read(); // banner
    await write(`EHLO ara-dashboard`);
    if (options.user && options.pass) {
      await write("AUTH LOGIN");
      await write(Buffer.from(options.user).toString("base64"));
      await write(Buffer.from(options.pass).toString("base64"));
    }
    await write(`MAIL FROM:<${options.from}>`);
    await write(`RCPT TO:<${options.to}>`);
    await write("DATA");
    const payload = [
      `From: ${options.from}`,
      `To: ${options.to}`,
      `Subject: ${options.subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      options.body,
      ".",
    ].join("\r\n");
    socket.write(`${payload}\r\n`);
    await read();
    await write("QUIT");
  } finally {
    socket.end();
    socket.destroy();
  }
}
