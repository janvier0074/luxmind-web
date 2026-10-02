const PDFDocument = require('pdfkit');
const crypto = require('crypto');

function generateCode() {
  return 'LXM-' + crypto.randomBytes(4).toString('hex').toUpperCase() +
         '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

function generateCertificatePDF(res, { studentName, courseTitle, teacherName, issuedAt, code }) {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="certificate-' + code + '.pdf"');
  doc.pipe(res);

  const W = doc.page.width;
  const H = doc.page.height;

  // gradient-ish background (solid blocks since PDFKit has no gradients easily)
  doc.rect(0, 0, W, H).fill('#0f172a');

  // decorative circles (blobs)
  doc.save();
  doc.circle(120, 100, 180).fill('#6366f1');
  doc.circle(W - 80, H - 60, 200).fill('#8b5cf6');
  doc.circle(W - 220, 80, 120).fill('#ec4899');
  doc.restore();

  // translucent white card
  doc.save();
  doc.opacity(0.96);
  doc.roundedRect(40, 40, W - 80, H - 80, 24).fill('#ffffff');
  doc.restore();

  // inner border
  doc.save();
  doc.lineWidth(2).strokeColor('#6366f1');
  doc.roundedRect(56, 56, W - 112, H - 112, 18).stroke();
  doc.restore();

  // top badge
  doc.save();
  doc.fontSize(11).fillColor('#6366f1').font('Helvetica-Bold');
  doc.text('LUXMIND LEARNING PLATFORM', 0, 100, { align: 'center', width: W, characterSpacing: 3 });
  doc.restore();

  // big title
  doc.save();
  doc.fontSize(46).fillColor('#0f172a').font('Helvetica-Bold');
  doc.text('Certificate of Completion', 0, 130, { align: 'center', width: W });
  doc.restore();

  // subtitle
  doc.save();
  doc.fontSize(13).fillColor('#64748b').font('Helvetica');
  doc.text('This is to certify that', 0, 210, { align: 'center', width: W });
  doc.restore();

  // student name
  doc.save();
  doc.fontSize(36).fillColor('#4f46e5').font('Helvetica-Bold');
  doc.text(studentName, 0, 245, { align: 'center', width: W });
  doc.restore();

  // line under name
  const lineW = 380;
  doc.save();
  doc.lineWidth(1.2).strokeColor('#c7d2fe');
  doc.moveTo((W - lineW) / 2, 300).lineTo((W + lineW) / 2, 300).stroke();
  doc.restore();

  // middle text
  doc.save();
  doc.fontSize(13).fillColor('#64748b').font('Helvetica');
  doc.text('has successfully completed the course', 0, 320, { align: 'center', width: W });
  doc.restore();

  // course title
  doc.save();
  doc.fontSize(22).fillColor('#0f172a').font('Helvetica-Bold');
  doc.text(courseTitle, 0, 348, { align: 'center', width: W });
  doc.restore();

  // teacher + date + code row
  const yRow = H - 170;

  doc.save();
  doc.fontSize(9).fillColor('#94a3b8').font('Helvetica-Bold');
  doc.text('INSTRUCTOR', 130, yRow, { width: 200, align: 'center', characterSpacing: 2 });
  doc.text('ISSUED ON', 0, yRow, { width: W, align: 'center', characterSpacing: 2 });
  doc.text('CERTIFICATE ID', W - 330, yRow, { width: 200, align: 'center', characterSpacing: 2 });
  doc.restore();

  doc.save();
  doc.fontSize(13).fillColor('#0f172a').font('Helvetica-Bold');
  doc.text(teacherName || 'LuxMind Instructor', 130, yRow + 16, { width: 200, align: 'center' });
  doc.text(issuedAt, 0, yRow + 16, { width: W, align: 'center' });
  doc.text(code, W - 330, yRow + 16, { width: 200, align: 'center', characterSpacing: 0.5 });
  doc.restore();

  // footer
  doc.save();
  doc.fontSize(9).fillColor('#94a3b8').font('Helvetica');
  doc.text('Verify this certificate at luxmind.app/verify/' + code, 0, H - 80, { align: 'center', width: W });
  doc.restore();

  doc.end();
}

module.exports = { generateCode, generateCertificatePDF };