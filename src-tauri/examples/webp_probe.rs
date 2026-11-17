fn main() {
    let img = image::RgbImage::new(8, 8);
    let mut buf = std::io::Cursor::new(Vec::new());
    let result = img.write_to(&mut buf, image::ImageFormat::WebP);
    match result {
        Ok(()) => println!("WEBP_ENCODE_OK bytes={}", buf.get_ref().len()),
        Err(e) => println!("WEBP_ENCODE_ERR {e}"),
    }
    // 解码能力
    let png = {
        let mut c = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(image::RgbImage::new(4, 4))
            .write_to(&mut c, image::ImageFormat::Png)
            .unwrap();
        c.into_inner()
    };
    match image::load_from_memory(&png) {
        Ok(d) => println!("PNG_DECODE_OK {}x{}", d.width(), d.height()),
        Err(e) => println!("PNG_DECODE_ERR {e}"),
    }
}
