const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');

const svgPath = path.join(__dirname, '../public/icon.svg');
const traySvgPath = path.join(__dirname, '../public/tray-icon.svg');
const publicDir = path.join(__dirname, '../public');

const icoSizes = [256, 128, 64, 48, 32, 16];
const linuxSizes = [256, 128, 64, 48, 32, 24, 16];

async function generateIcons() {
  console.log('Generating icons...');
  
  try {
    // Create temp directory for PNGs
    const tempDir = path.join(publicDir, '.temp-icons');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Create Linux icons directory
    const linuxIconsDir = path.join(publicDir, 'icons');
    if (!fs.existsSync(linuxIconsDir)) {
      fs.mkdirSync(linuxIconsDir, { recursive: true });
    }
    
    // Generate PNG icons for Linux and ICO
    const pngPaths = [];
    for (const size of linuxSizes) {
      const outputPath = path.join(linuxIconsDir, `${size}x${size}.png`);
      await sharp(svgPath)
        .resize(size, size)
        .png()
        .toFile(outputPath);
      console.log(`Generated: ${outputPath}`);
      
      if (icoSizes.includes(size)) {
        const tempPath = path.join(tempDir, `${size}x${size}.png`);
        await sharp(svgPath)
          .resize(size, size)
          .png()
          .toFile(tempPath);
        pngPaths.push(tempPath);
      }
    }
    
    // Generate ICO for Windows using png-to-ico
    const icoOutput = path.join(publicDir, 'icon.ico');
    const icoBuffer = await pngToIco(pngPaths);
    fs.writeFileSync(icoOutput, icoBuffer);
    console.log(`Generated: ${icoOutput}`);
    
    // Generate tray icon PNG
    const trayPngOutput = path.join(publicDir, 'tray-icon.png');
    await sharp(traySvgPath)
      .resize(64, 64)
      .png()
      .toFile(trayPngOutput);
    console.log(`Generated: ${trayPngOutput}`);
    
    // Generate favicon
    const faviconTempPaths = [];
    for (const size of [32, 16]) {
      const tempPath = path.join(tempDir, `favicon-${size}x${size}.png`);
      await sharp(svgPath)
        .resize(size, size)
        .png()
        .toFile(tempPath);
      faviconTempPaths.push(tempPath);
    }
    const faviconBuffer = await pngToIco(faviconTempPaths);
    const faviconOutput = path.join(publicDir, 'favicon.ico');
    fs.writeFileSync(faviconOutput, faviconBuffer);
    console.log(`Generated: ${faviconOutput}`);
    
    // Cleanup temp directory
    fs.rmdirSync(tempDir, { recursive: true });
    
    console.log('✅ All icons generated successfully!');
    
  } catch (error) {
    console.error('❌ Error generating icons:', error);
    process.exit(1);
  }
}

generateIcons();
