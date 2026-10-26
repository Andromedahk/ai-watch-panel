package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"time"
)

type byteCounter int64

func (c *byteCounter) Write(p []byte) (int, error) {
	*c += byteCounter(len(p))
	return len(p), nil
}

// This explicitly requested diagnostic never opens USB or changes the device.
// Results measure PNG encoding only, not JPEG decode, IPC or GStreamer display.
func benchmarkPNG(output io.Writer) error {
	const iterations = 3
	type result struct {
		Width                int     `json:"width"`
		Height               int     `json:"height"`
		Pattern              string  `json:"pattern"`
		Compression          string  `json:"compression"`
		MillisecondsPerFrame float64 `json:"milliseconds_per_frame"`
		BytesPerFrame        int64   `json:"bytes_per_frame"`
		Iterations           int     `json:"iterations"`
	}
	writer := json.NewEncoder(output)
	for _, size := range [][2]int{{1280, 720}, {2240, 1080}} {
		for _, pattern := range []string{"desktop", "noise"} {
			canvas := image.NewRGBA(image.Rect(0, 0, size[0], size[1]))
			seed := uint32(0x524B3566)
			for y := 0; y < size[1]; y++ {
				for x := 0; x < size[0]; x++ {
					p := canvas.Pix[y*canvas.Stride+x*4:]
					if pattern == "noise" {
						seed ^= seed << 13
						seed ^= seed >> 17
						seed ^= seed << 5
						p[0], p[1], p[2] = uint8(seed), uint8(seed>>8), uint8(seed>>16)
					} else {
						// Flat windows, alternating text rows and a gradient sidebar.
						p[0], p[1], p[2] = 24, 28, 35
						if x < size[0]/5 {
							p[0], p[1], p[2] = uint8(y*80/size[1]), 65, 105
						}
						if x > size[0]/4 && x < size[0]*4/5 && y%24 < 3 {
							p[0], p[1], p[2] = 180, 188, 198
						}
					}
					p[3] = 255
				}
			}
			for _, compression := range []struct {
				name  string
				level png.CompressionLevel
			}{{"none", png.NoCompression}, {"best_speed", png.BestSpeed}} {
				pool := pngBufferPool{}
				encoder := png.Encoder{CompressionLevel: compression.level, BufferPool: &pool}
				if err := encoder.Encode(io.Discard, canvas); err != nil {
					return fmt.Errorf("warmup: %w", err)
				}
				var count byteCounter
				started := time.Now()
				for i := 0; i < iterations; i++ {
					if err := encoder.Encode(&count, canvas); err != nil {
						return err
					}
				}
				r := result{size[0], size[1], pattern, compression.name, float64(time.Since(started).Microseconds()) / 1000 / iterations, int64(count) / iterations, iterations}
				if err := writer.Encode(r); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
