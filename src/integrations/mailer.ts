/**
 * Pengirim email (nodemailer, opsional). Jika SMTP belum diatur atau paket belum terpasang,
 * isi email dicetak ke log server (hanya di luar production) supaya alur tetap bisa dicoba.
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
 */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const host = process.env.SMTP_HOST;
  if (host) {
    try {
      const moduleName = "nodemailer";
      const nodemailer: any = await import(moduleName);
      const transport = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT ?? 587),
        secure: Number(process.env.SMTP_PORT ?? 587) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      });
      await transport.sendMail({ from: process.env.MAIL_FROM ?? "ElderCare AI <no-reply@eldercare.local>", to, subject, text });
      return true;
    } catch (e) {
      console.error("Gagal mengirim email:", (e as Error).message);
    }
  }
  if (process.env.NODE_ENV !== "production") {
    console.log(`\n[EMAIL-DEV] Kepada: ${to}\nSubjek: ${subject}\n${text}\n`);
  }
  return false;
}
