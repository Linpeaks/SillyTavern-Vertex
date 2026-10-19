/** A synthetic one-page PDF with text, a vector chart and a raster image.
 * @param {string} label ASCII fixture label
 * @param {number} pageCount Page count for limit checks
 * @returns {Buffer} PDF with real offsets, no private data
 */
export function makePdf(label = 'Synthetic document', pageCount = 1) {
    const content = `BT /F1 12 Tf 20 160 Td (${label}) Tj ET\n0 0 1 rg 20 30 25 70 re f\n1 0 0 rg 55 30 25 100 re f\nq 20 0 0 20 120 50 cm /Im1 Do Q`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
        '<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nRGB\nendstream',
    ];
    const kids = ['3 0 R'];
    for (let index = 1; index < pageCount; index++) {
        objects.push(objects[2]);
        kids.push(`${objects.length} 0 R`);
    }
    objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>`;
    let value = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, index) => {
        offsets.push(Buffer.byteLength(value));
        value += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(value);
    value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    value += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(value);
}
