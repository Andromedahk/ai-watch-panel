package main

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/draw"
	"image/jpeg"
	"image/png"
)

const deltaFormat = 3
const maxCanvasPixels = 2240 * 1080
const maxDeltaRects = 256

// deltaState and its encoder buffers are confined to the USB command goroutine.
// The RGBA canvas is always opaque after the first full reference frame.
type deltaState struct {
	canvas      *image.RGBA
	sequence    uint32
	initialized bool
	encoder     png.Encoder
	encoderPool pngBufferPool
}

// PNG encoders otherwise allocate fresh DEFLATE and row buffers every frame.
// Only one frame is encoded at a time, so a single reusable slot is sufficient.
type pngBufferPool struct{ buffer *png.EncoderBuffer }

func (p *pngBufferPool) Get() *png.EncoderBuffer {
	b := p.buffer
	p.buffer = nil
	return b
}

func (p *pngBufferPool) Put(b *png.EncoderBuffer) { p.buffer = b }

func validVideoSize(width, height, fps uint64) error {
	if width < 64 || height < 64 || width > 4096 || height > 4096 || width*height > maxCanvasPixels {
		return fmt.Errorf("invalid canvas %dx%d (64..4096, at most %d pixels)", width, height, maxCanvasPixels)
	}
	if fps < 1 || fps > 60 {
		return fmt.Errorf("invalid frame rate %d (1..60)", fps)
	}
	return nil
}

func newDeltaState(width, height int) *deltaState {
	s := &deltaState{canvas: image.NewRGBA(image.Rect(0, 0, width, height))}
	s.encoder = png.Encoder{CompressionLevel: png.NoCompression, BufferPool: &s.encoderPool}
	return s
}

// apply validates and decodes the entire packet before touching the reference
// canvas. A rejected packet can therefore be retried with the same sequence.
// Heartbeats advance the sequence but return changed=false.
func (s *deltaState) apply(packet []byte) (changed bool, err error) {
	if len(packet) < 12 || string(packet[:4]) != "XDP1" {
		return false, fmt.Errorf("invalid XDP1 header")
	}
	sequence := binary.LittleEndian.Uint32(packet[4:8])
	count := int(binary.LittleEndian.Uint16(packet[8:10]))
	flags := binary.LittleEndian.Uint16(packet[10:12])
	if count > maxDeltaRects || flags & ^uint16(1) != 0 {
		return false, fmt.Errorf("invalid rectangle count or flags")
	}
	wantSequence := s.sequence + 1
	if sequence != wantSequence {
		return false, fmt.Errorf("unexpected sequence %d, want %d", sequence, wantSequence)
	}
	reset := flags&1 != 0
	if !s.initialized && !reset {
		return false, fmt.Errorf("initial packet must reset the full canvas")
	}
	if reset && count != 1 {
		return false, fmt.Errorf("reset must contain exactly one full-canvas rectangle")
	}
	type patch struct {
		bounds image.Rectangle
		data   []byte
		image  image.Image
	}
	patches := make([]patch, 0, count)
	pos := 12
	// Parse every rectangle and JPEG header before decoding or allocating image
	// pixels. JPEG dimensions must agree with the bounded rectangle dimensions.
	decodedPixels := 0
	for i := 0; i < count; i++ {
		if len(packet)-pos < 12 {
			return false, fmt.Errorf("truncated rectangle %d", i)
		}
		x := int(binary.LittleEndian.Uint16(packet[pos:]))
		y := int(binary.LittleEndian.Uint16(packet[pos+2:]))
		w := int(binary.LittleEndian.Uint16(packet[pos+4:]))
		h := int(binary.LittleEndian.Uint16(packet[pos+6:]))
		n := uint64(binary.LittleEndian.Uint32(packet[pos+8:]))
		pos += 12
		r := image.Rect(x, y, x+w, y+h)
		if w == 0 || h == 0 || !r.In(s.canvas.Bounds()) {
			return false, fmt.Errorf("rectangle %d exceeds canvas", i)
		}
		if reset && r != s.canvas.Bounds() {
			return false, fmt.Errorf("reset rectangle must cover the complete canvas")
		}
		if n == 0 || n > uint64(len(packet)-pos) || n > 16*1024*1024 {
			return false, fmt.Errorf("invalid JPEG size for rectangle %d", i)
		}
		decodedPixels += w * h
		if decodedPixels > maxCanvasPixels*2 {
			return false, fmt.Errorf("too many decoded pixels in one packet")
		}
		data := packet[pos : pos+int(n)]
		pos += int(n)
		cfg, err := jpeg.DecodeConfig(bytes.NewReader(data))
		if err != nil || cfg.Width != w || cfg.Height != h {
			return false, fmt.Errorf("JPEG dimensions do not match rectangle %d", i)
		}
		patches = append(patches, patch{bounds: r, data: data})
	}
	if pos != len(packet) {
		return false, fmt.Errorf("trailing bytes in XDP1 packet")
	}
	for i := range patches {
		decoded, err := jpeg.Decode(bytes.NewReader(patches[i].data))
		if err != nil {
			return false, fmt.Errorf("decode rectangle %d: %w", i, err)
		}
		patches[i].image = decoded
	}
	for _, p := range patches {
		draw.Draw(s.canvas, p.bounds, p.image, p.image.Bounds().Min, draw.Src)
	}
	s.sequence = sequence
	s.initialized = true
	return count != 0, nil
}
