package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"image/png"
	"testing"
)

type testRect struct {
	x, y, w, h uint16
	jpeg       []byte
}

func jpegImage(t *testing.T, w, h int, c color.Color) []byte {
	t.Helper()
	im := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(im, im.Bounds(), &image.Uniform{C: c}, image.Point{}, draw.Src)
	var b bytes.Buffer
	if err := jpeg.Encode(&b, im, &jpeg.Options{Quality: 95}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func deltaPacket(sequence uint32, flags uint16, rects ...testRect) []byte {
	b := new(bytes.Buffer)
	b.WriteString("XDP1")
	_ = binary.Write(b, binary.LittleEndian, sequence)
	_ = binary.Write(b, binary.LittleEndian, uint16(len(rects)))
	_ = binary.Write(b, binary.LittleEndian, flags)
	for _, r := range rects {
		for _, v := range []uint16{r.x, r.y, r.w, r.h} {
			_ = binary.Write(b, binary.LittleEndian, v)
		}
		_ = binary.Write(b, binary.LittleEndian, uint32(len(r.jpeg)))
		b.Write(r.jpeg)
	}
	return b.Bytes()
}

func initializedDelta(t *testing.T) *deltaState {
	t.Helper()
	s := newDeltaState(64, 64)
	_, err := s.apply(deltaPacket(1, 1, testRect{0, 0, 64, 64, jpegImage(t, 64, 64, color.RGBA{R: 240, A: 255})}))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestDeltaCompositesOnlyChangedRectangle(t *testing.T) {
	s := initializedDelta(t)
	outside := s.canvas.RGBAAt(3, 3)
	changed, err := s.apply(deltaPacket(2, 0, testRect{16, 24, 8, 8, jpegImage(t, 8, 8, color.RGBA{G: 240, A: 255})}))
	if err != nil || !changed {
		t.Fatalf("apply: %v %v", changed, err)
	}
	if s.canvas.RGBAAt(3, 3) != outside {
		t.Fatal("unchanged pixels modified")
	}
	pixel := s.canvas.RGBAAt(18, 27)
	if pixel.G < 230 || pixel.R > 10 || pixel.A != 255 {
		t.Fatalf("wrong patch color: %v", pixel)
	}
	saved := append([]byte(nil), s.canvas.Pix...)
	changed, err = s.apply(deltaPacket(3, 0))
	if err != nil || changed || s.sequence != 3 || !bytes.Equal(saved, s.canvas.Pix) {
		t.Fatalf("heartbeat changed canvas or failed: changed=%v error=%v sequence=%d", changed, err, s.sequence)
	}
}

func TestDeltaRejectsMalformedPacketsAtomically(t *testing.T) {
	jpg := jpegImage(t, 8, 8, color.White)
	valid := testRect{4, 4, 8, 8, jpg}
	corrupt := append([]byte(nil), jpg[:len(jpg)-12]...)
	cases := map[string][]byte{
		"magic":               []byte("BAD!abcdefgh"),
		"header":              []byte("XDP1"),
		"sequence":            deltaPacket(8, 0, valid),
		"flags":               deltaPacket(2, 2, valid),
		"empty reset":         deltaPacket(2, 1),
		"partial reset":       deltaPacket(2, 1, valid),
		"multiple reset":      deltaPacket(2, 1, valid, valid),
		"bounds":              deltaPacket(2, 0, testRect{60, 60, 8, 8, jpg}),
		"empty rectangle":     deltaPacket(2, 0, testRect{0, 0, 0, 8, jpg}),
		"dimensions":          deltaPacket(2, 0, testRect{0, 0, 16, 8, jpg}),
		"trailing bytes":      append(deltaPacket(2, 0, valid), 0),
		"second decode fails": deltaPacket(2, 0, valid, testRect{20, 20, 8, 8, corrupt}),
		"second header fails": deltaPacket(2, 0, valid, testRect{20, 20, 8, 8, []byte("not JPEG")}),
	}
	tooMany := deltaPacket(2, 0)
	binary.LittleEndian.PutUint16(tooMany[8:10], maxDeltaRects+1)
	cases["count limit"] = tooMany
	truncated := deltaPacket(2, 0, valid)
	cases["truncated jpeg"] = truncated[:len(truncated)-1]
	for name, packet := range cases {
		t.Run(name, func(t *testing.T) {
			s := initializedDelta(t)
			before := append([]byte(nil), s.canvas.Pix...)
			if changed, err := s.apply(packet); err == nil || changed {
				t.Fatalf("malformed packet accepted: %v, %v", changed, err)
			}
			if s.sequence != 1 || !bytes.Equal(before, s.canvas.Pix) {
				t.Fatal("rejected packet changed canvas or sequence")
			}
			if _, err := s.apply(deltaPacket(2, 0, valid)); err != nil {
				t.Fatalf("valid retry failed: %v", err)
			}
		})
	}
}

func TestDeltaRequiresInitialKeyframeAndAllowsSequenceWrap(t *testing.T) {
	s := newDeltaState(64, 64)
	if _, err := s.apply(deltaPacket(1, 0)); err == nil {
		t.Fatal("accepted initial heartbeat")
	}
	if s.initialized || s.sequence != 0 {
		t.Fatal("invalid initial packet changed state")
	}
	s = initializedDelta(t)
	s.sequence = ^uint32(0)
	if _, err := s.apply(deltaPacket(0, 0)); err != nil {
		t.Fatalf("wrap failed: %v", err)
	}
}

type brokenPNGWriter struct{}

func (brokenPNGWriter) Write([]byte) (int, error) { return 0, errors.New("test pipe failure") }

func TestReusablePNGEncoderSurvivesWriteFailureAndNewFrame(t *testing.T) {
	s := initializedDelta(t)
	if err := s.encoder.Encode(brokenPNGWriter{}, s.canvas); err == nil {
		t.Fatal("write failure was ignored")
	}
	for seq := uint32(2); seq < 4; seq++ {
		_, err := s.apply(deltaPacket(seq, 0, testRect{8, 8, 8, 8, jpegImage(t, 8, 8, color.RGBA{B: uint8(80 * seq), A: 255})}))
		if err != nil {
			t.Fatal(err)
		}
		var encoded bytes.Buffer
		if err := s.encoder.Encode(&encoded, s.canvas); err != nil {
			t.Fatal(err)
		}
		decoded, err := png.Decode(&encoded)
		if err != nil {
			t.Fatal(err)
		}
		if decoded.Bounds() != s.canvas.Bounds() {
			t.Fatal("wrong encoded dimensions")
		}
		for _, point := range []image.Point{{0, 0}, {10, 10}, {63, 63}} {
			got := color.RGBAModel.Convert(decoded.At(point.X, point.Y)).(color.RGBA)
			if got != s.canvas.RGBAAt(point.X, point.Y) {
				t.Fatalf("PNG did not retain exact composed pixel at %v", point)
			}
		}
		if s.encoderPool.buffer == nil {
			t.Fatal("PNG buffer was not returned to pool")
		}
	}
}

func TestVideoSizeLimits(t *testing.T) {
	for _, dims := range [][3]uint64{{2240, 1080, 30}, {1920, 1080, 60}, {64, 64, 1}} {
		if err := validVideoSize(dims[0], dims[1], dims[2]); err != nil {
			t.Fatal(err)
		}
	}
	for _, dims := range [][3]uint64{{0, 1080, 30}, {63, 64, 30}, {4096, 4096, 30}, {1920, 1080, 0}, {1920, 1080, 61}, {^uint64(0), 64, 30}} {
		if err := validVideoSize(dims[0], dims[1], dims[2]); err == nil {
			t.Fatalf("accepted %v", dims)
		}
	}
}

func TestTRYXReassemblyAtEveryChunkSize(t *testing.T) {
	bodies := [][]byte{cat(pbMsg(1, header(10)), pbMsg(407, cat(pbUint(1, 3), pbUint(2, 30), pbUint(3, 64), pbUint(4, 64)))), cat(pbMsg(1, header(11)), pbMsg(408, pbBytes(1, deltaPacket(1, 0))))}
	stream := append(frame(bodies[0]), frame(bodies[1])...)
	for chunkSize := 1; chunkSize <= len(stream); chunkSize++ {
		r := frameReader{}
		var out [][]byte
		for pos := 0; pos < len(stream); pos += chunkSize {
			end := pos + chunkSize
			if end > len(stream) {
				end = len(stream)
			}
			out = append(out, r.feed(stream[pos:end])...)
		}
		if len(out) != 2 || !bytes.Equal(out[0], bodies[0]) || !bytes.Equal(out[1], bodies[1]) {
			t.Fatalf("reassembly failed at chunk size %d", chunkSize)
		}
	}
}

func TestProtobufOverflowAndTruncationDoNotPanic(t *testing.T) {
	if value, pos, ok := readVarint(varint(^uint64(0)), 0); !ok || value != ^uint64(0) || pos != 10 {
		t.Fatal("valid maximum uint64 rejected")
	}
	for _, raw := range [][]byte{
		{0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01}, // length exceeds int64
		{0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02}, // uint64 overflow
		{0x0a, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01},
		{0x0a, 0x05, 0x01}, // truncated bytes field
		{0x00, 0x01},       // reserved field zero
	} {
		if fields := pbParse(raw); len(fields) != 0 {
			t.Fatalf("malformed protobuf was accepted: %x", raw)
		}
	}
}
