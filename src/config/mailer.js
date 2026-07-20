import nodemailer from "nodemailer";
import dotenv from "dotenv";
dotenv.config();

// 1️⃣ Create main transporter for general emails (using Hostinger SMTP)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: true, // use true for 465
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 2️⃣ Create SMTP transporter (for system-generated mails)
const smtpTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 3️⃣ Generic sendEmail function (uses Hostinger SMTP)
export const sendEmail = async (to, subject, html) => {
  try {
    const mailOptions = {
      from: `"CreatikAI Team" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    };
    const info = await transporter.sendMail(mailOptions);
    console.log("✅ Email sent:", info.response);
    return info;
  } catch (error) {
    console.error("❌ Email error:", error.message);
    throw error;
  }
};

// 4️⃣ System-generated mail function (unchanged)
export const sendSystemEmail = async (to, userName, password, role) => {
  try {
    let subject = "Your Account Has Been Created";
    let roleSpecificMessage = "";

    switch (role) {
      case "administrator":
        roleSpecificMessage = `
          <p>Welcome aboard as an <b>Administrator</b>!</p>
          <p>You now have full access to manage system operations, city admins, and users.</p>
        `;
        break;
      case "city_admin":
        roleSpecificMessage = `
          <p>Welcome aboard as a <b>City Admin</b>!</p>
          <p>You are now authorized to manage users within your assigned city.</p>
        `;
        break;
      default:
        roleSpecificMessage = `
          <p>Welcome aboard as a <b>User</b>!</p>
          <p>You can now log in and access your assigned city’s services and dashboard.</p>
        `;
        break;
    }

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 10px;">
        <h2 style="color: #333;">Welcome to Our System, ${userName} 👋</h2>
        ${roleSpecificMessage}
        <p>Here are your login details:</p>
        <ul>
          <li><b>Email:</b> ${to}</li>
          <li><b>Password:</b> ${password}</li>
        </ul>
        <p style="color: #d9534f;"><b>⚠️ Please log in and change your password immediately for security purposes.</b></p>
        <br />
        <p>Best Regards,<br/><b>Admin Team</b></p>
      </div>
    `;
    

    const mailOptions = {
      from: `"System Notification" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html,
    };
    

    const info = await smtpTransporter.sendMail(mailOptions);
    console.log("✅ System email sent:", info.response);
    return info;
  } catch (error) {
    console.error("❌ System email error:", error.message);
    throw error;
  }
};
