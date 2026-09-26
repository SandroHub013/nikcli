// SPDX-License-Identifier: GPL-3.0-or-later
//! The one file this process writes: a 24 kHz mono 16-bit WAV.

use std::io;

/// Byte count of the RIFF/WAVE header that precedes the samples.
pub const HEADER_LEN: usize = 44;

/// 44 bytes of header for mono 16-bit PCM at `sample_rate`.
pub fn header(sample_rate: i32, data_len: u32) -> [u8; HEADER_LEN] {
    let mut bytes = [0u8; HEADER_LEN];

    bytes[0..4].copy_from_slice(b"RIFF");
    bytes[4..8].copy_from_slice(&(36 + data_len).to_le_bytes());
    bytes[8..12].copy_from_slice(b"WAVE");
    bytes[12..16].copy_from_slice(b"fmt ");
    bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
    bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
    bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
    bytes[24..28].copy_from_slice(&(sample_rate.max(0) as u32).to_le_bytes());
    bytes[28..32].copy_from_slice(&((sample_rate.max(0) as u32) * 2).to_le_bytes());
    bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
    bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
    bytes[36..40].copy_from_slice(b"data");
    bytes[40..44].copy_from_slice(&data_len.to_le_bytes());

    bytes
}

/// Header plus samples, in the order they go on disk.
pub fn encode(sample_rate: i32, samples: &[f32]) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(HEADER_LEN + data_len as usize);
    bytes.extend_from_slice(&header(sample_rate, data_len));
    for sample in samples {
        let scaled = (sample.clamp(-1.0, 1.0) * 32_767.0).round();
        bytes.extend_from_slice(&(scaled as i16).to_le_bytes());
    }
    bytes
}

/// Write the WAV where the request pointed.
pub fn write(path: &str, sample_rate: i32, samples: &[f32]) -> io::Result<()> {
    std::fs::write(path, encode(sample_rate, samples))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_header_describes_mono_16_bit_pcm() {
        let header = header(24_000, 10);
        assert_eq!(&header[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 46);
        assert_eq!(&header[8..12], b"WAVE");
        assert_eq!(&header[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(header[16..20].try_into().unwrap()), 16);
        assert_eq!(u16::from_le_bytes(header[20..22].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 1);
        assert_eq!(
            u32::from_le_bytes(header[24..28].try_into().unwrap()),
            24_000
        );
        assert_eq!(
            u32::from_le_bytes(header[28..32].try_into().unwrap()),
            48_000,
            "byte rate is one channel, two bytes, per second"
        );
        assert_eq!(u16::from_le_bytes(header[32..34].try_into().unwrap()), 2);
        assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 16);
        assert_eq!(&header[36..40], b"data");
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 10);
    }

    #[test]
    fn the_header_is_always_forty_four_bytes() {
        assert_eq!(header(24_000, 0).len(), HEADER_LEN);
        assert_eq!(header(48_000, 999).len(), HEADER_LEN);
    }

    #[test]
    fn samples_are_clamped_and_little_endian() {
        let bytes = encode(24_000, &[0.0, 1.0, -1.0, 2.0, -2.0]);
        assert_eq!(bytes.len(), HEADER_LEN + 5 * 2);
        assert_eq!(&bytes[44..46], &[0x00, 0x00]);
        assert_eq!(&bytes[46..48], &[0xFF, 0x7F], "1.0 saturates at 32767");
        assert_eq!(&bytes[48..50], &[0x01, 0x80], "-1.0 saturates at -32767");
        assert_eq!(&bytes[50..52], &[0xFF, 0x7F], "2.0 is clamped, not wrapped");
        assert_eq!(&bytes[52..54], &[0x01, 0x80]);
    }

    #[test]
    fn an_empty_answer_still_has_a_header() {
        let bytes = encode(24_000, &[]);
        assert_eq!(bytes.len(), HEADER_LEN);
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(bytes[40..44].try_into().unwrap()),
            0,
            "no samples, no data"
        );
    }

    #[test]
    fn a_wav_lands_on_disk() {
        let path = std::env::temp_dir().join("kokoro-host-test-wav-write.wav");
        let path = path.to_string_lossy().into_owned();
        write(&path, 24_000, &[0.25, -0.25]).expect("write");
        let bytes = std::fs::read(&path).expect("read back");
        assert_eq!(&bytes[..4], b"RIFF");
        assert_eq!(bytes.len(), HEADER_LEN + 4);
        let _ = std::fs::remove_file(&path);
    }
}
