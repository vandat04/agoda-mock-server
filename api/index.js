/**
 * Agoda Mock Server - Chức năng giả lập Channel Manager phục vụ thử nghiệm và đồ án
 * Chạy độc lập, không phụ thuộc vào npm packages (Zero Dependencies).
 * Hỗ trợ chạy cả Standalone (local) và Serverless Function (Vercel).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Tự động phát hiện môi trường chạy để chọn endpoint CheckinX phù hợp
const CHECKINX_BASE_URL = (process.env.RENDER || process.env.VERCEL)
    ? 'https://hotel-booking-v3.onrender.com/api'
    : 'http://localhost:8080/api';
const CHECKINX_API_URL = `${CHECKINX_BASE_URL}/admin/ota-channels/booking`;

// Bộ nhớ đệm lưu danh sách đặt phòng giả lập trên Agoda (Được lưu trong file mock_bookings.json)
const BOOKINGS_FILE = path.join(process.cwd(), 'mock_bookings.json');
let mockBookings = [];

try {
    if (fs.existsSync(BOOKINGS_FILE)) {
        mockBookings = JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
        console.log(`[Database] Đã tải ${mockBookings.length} đặt phòng từ file mock_bookings.json`);
    } else {
        mockBookings = [
            {
                bookingId: "AGD-17263541",
                guestName: "Nguyen Van A",
                guestPhone: "0912345678",
                guestEmail: "nguyenvana@gmail.com",
                roomTypeCode: "STANDARD",
                checkIn: "2026-07-01",
                checkOut: "2026-07-03",
                amount: 800000,
                status: "CONFIRMED",
                createdAt: new Date().toISOString()
            }
        ];
        try {
            fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(mockBookings, null, 2), 'utf8');
            console.log(`[Database] Đã khởi tạo file mock_bookings.json`);
        } catch (errWrite) {
            console.warn("[Database] Không thể ghi file khởi tạo (có thể đang chạy ở môi trường read-only như Vercel):", errWrite.message);
        }
    }
} catch (e) {
    console.error("Lỗi đọc/ghi file mock_bookings.json:", e.message);
    mockBookings = [];
}

// Hàm lưu booking vào file (Sẽ bỏ qua nếu filesystem bị read-only)
function saveBookingsToFile() {
    try {
        fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(mockBookings, null, 2), 'utf8');
    } catch (e) {
        console.warn("[Database] Không thể lưu file mock_bookings.json (chạy trên Vercel file sẽ được giữ tạm thời trong RAM):", e.message);
    }
}

// Hàm chuẩn hóa tên loại phòng
function normalizeRoomType(roomType) {
    const rt = roomType.toUpperCase();
    if (rt.includes("DELUXE")) return "DELUXE";
    if (rt.includes("SUITE") || rt.includes("VIP")) return "VIP";
    if (rt.includes("STANDARD")) return "STANDARD";
    return rt;
}

// Hàm sinh nội dung iCal (.ics) động dựa trên danh sách đặt phòng
function generateICal(roomType) {
    let ics = [];
    ics.push("BEGIN:VCALENDAR");
    ics.push("VERSION:2.0");
    ics.push("PRODID:-//AgodaMock//Channel Manager Simulation//EN");
    ics.push("CALSCALE:GREGORIAN");
    ics.push("METHOD:PUBLISH");

    const normType = normalizeRoomType(roomType);

    const filtered = mockBookings.filter(b => 
        normalizeRoomType(b.roomTypeCode) === normType && b.status === "CONFIRMED"
    );

    filtered.forEach(booking => {
        ics.push("BEGIN:VEVENT");
        ics.push(`UID:${booking.bookingId}@agoda-mock.com`);
        ics.push(`DTSTAMP:${formatDateToICal(new Date().toISOString().slice(0,10))}T000000Z`);
        
        // iCal all-day format
        const start = formatDateToICal(booking.checkIn);
        const end = formatDateToICal(booking.checkOut);
        
        ics.push(`DTSTART;VALUE=DATE:${start}`);
        ics.push(`DTEND;VALUE=DATE:${end}`);
        ics.push(`SUMMARY:Agoda Booking - ${booking.guestName}`);
        ics.push(`DESCRIPTION:Phone: ${booking.guestPhone} | Email: ${booking.guestEmail}`);
        ics.push("END:VEVENT");
    });

    ics.push("END:VCALENDAR");
    return ics.join("\r\n");
}

function formatDateToICal(dateStr) {
    return dateStr.replace(/-/g, '');
}

// Hàm tải lịch trống từ CheckinX và phân tích các ngày đã bán hết
function fetchAndParseCheckinxCalendar(roomTypeId, callback) {
    const icalUrl = `${CHECKINX_BASE_URL}/ical/room-type/${roomTypeId}.ics`;
    const client = icalUrl.startsWith('https') ? https : http;
    
    client.get(icalUrl, (res) => {
        if (res.statusCode !== 200) {
            callback(new Error(`CheckinX returned status ${res.statusCode}`), null);
            return;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            const blockedDates = [];
            const events = data.split('BEGIN:VEVENT');
            events.shift();

            events.forEach(eventStr => {
                const startMatch = eventStr.match(/DTSTART;VALUE=DATE:(\d{8})/);
                const endMatch = eventStr.match(/DTEND;VALUE=DATE:(\d{8})/);
                
                if (startMatch && endMatch) {
                    const startStr = startMatch[1];
                    const endStr = endMatch[1];
                    
                    const startY = parseInt(startStr.slice(0,4));
                    const startM = parseInt(startStr.slice(4,6)) - 1;
                    const startD = parseInt(startStr.slice(6,8));
                    
                    const endY = parseInt(endStr.slice(0,4));
                    const endM = parseInt(endStr.slice(4,6)) - 1;
                    const endD = parseInt(endStr.slice(6,8));
                    
                    const startDate = new Date(startY, startM, startD);
                    const endDate = new Date(endY, endM, endD);
                    
                    let current = new Date(startDate);
                    while (current < endDate) {
                        const dateStr = current.toISOString().slice(0, 10);
                        if (!blockedDates.includes(dateStr)) {
                            blockedDates.push(dateStr);
                        }
                        current.setDate(current.getDate() + 1);
                    }
                }
            });

            callback(null, blockedDates);
        });
    }).on('error', (err) => {
        callback(err, null);
    });
}

// Handler gửi Webhook đồng bộ đặt phòng sang CheckinX Spring Boot
function sendWebhookToCheckinX(booking, callback) {
    const postData = JSON.stringify({
        bookingId: booking.bookingId,
        otaChannel: "AGODA",
        otaHotelId: "1",
        guest: {
            fullName: booking.guestName,
            phone: booking.guestPhone,
            email: booking.guestEmail,
            nationality: "Vietnamese"
        },
        room: {
            roomTypeCode: booking.roomTypeCode,
            roomTypeName: booking.roomTypeCode,
            quantity: 1,
            adults: 2,
            children: 0
        },
        stay: {
            checkIn: booking.checkIn + "T14:00:00",
            checkOut: booking.checkOut + "T12:00:00",
            nights: Math.ceil((new Date(booking.checkOut) - new Date(booking.checkIn)) / (1000 * 60 * 60 * 24))
        },
        pricing: {
            currency: "VND",
            roomAmount: booking.amount,
            taxAmount: 0,
            serviceFee: 0,
            totalAmount: booking.amount,
            commissionAmount: booking.amount * 0.15
        },
        payment: {
            paymentType: "CREDIT_CARD",
            paymentStatus: "PAID"
        },
        status: "CONFIRMED",
        createdAt: booking.createdAt,
        lastUpdatedAt: booking.createdAt
    });

    const parsedUrl = url.parse(CHECKINX_API_URL);
    const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (CHECKINX_API_URL.startsWith('https') ? 443 : 80),
        path: parsedUrl.path,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    const client = CHECKINX_API_URL.startsWith('https') ? https : http;
    const req = client.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            callback(null, { statusCode: res.statusCode, body });
        });
    });

    req.on('error', (e) => {
        callback(e, null);
    });

    req.write(postData);
    req.end();
}

// Request Handler chính tương thích Vercel
const handler = (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 1. Giao diện người dùng (HTML)
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/api' || pathname === '/api/')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
        res.end(getHTMLContent());
        return;
    }

    // 2. Trả về lịch iCal động cho các loại phòng
    if (req.method === 'GET' && pathname.startsWith('/api/v1/ota/calendar/')) {
        const parts = pathname.split('/');
        const filename = parts[parts.length - 1];
        const roomType = filename.replace('.ics', '').replace(/-/g, ' ');
        
        let normalizedRoomType = "STANDARD";
        if (roomType.toLowerCase() === "suite" || roomType.toLowerCase() === "vip") {
            normalizedRoomType = "VIP";
        } else if (roomType.toLowerCase() === "standard") {
            normalizedRoomType = "STANDARD";
        } else if (roomType.toLowerCase() === "deluxe") {
            normalizedRoomType = "DELUXE";
        } else {
            normalizedRoomType = roomType.toUpperCase();
        }

        const icsContent = generateICal(normalizedRoomType);
        res.writeHead(200, { 
            'Content-Type': 'text/calendar; charset=UTF-8',
            'Content-Disposition': `attachment; filename="${filename}"`
        });
        res.end(icsContent);
        return;
    }

    // 3. API đặt phòng giả lập và trigger Webhook sang CheckinX
    if (req.method === 'POST' && pathname === '/api/mock-book') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.guestName || !data.roomTypeCode || !data.checkIn || !data.checkOut) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: "Thiếu thông tin bắt buộc!" }));
                    return;
                }

                const newBooking = {
                    bookingId: "AGD-" + Math.floor(Math.random() * 90000000 + 10000000),
                    guestName: data.guestName,
                    guestPhone: data.guestPhone || "0987654321",
                    guestEmail: data.guestEmail || "guest@agoda-mock.com",
                    roomTypeCode: data.roomTypeCode,
                    checkIn: data.checkIn,
                    checkOut: data.checkOut,
                    amount: data.amount ? parseInt(data.amount) : 1200000,
                    status: "CONFIRMED",
                    createdAt: new Date().toISOString()
                };

                sendWebhookToCheckinX(newBooking, (err, result) => {
                    if (err) {
                        console.error("Lỗi gửi Webhook đồng bộ:", err.message);
                        res.writeHead(502, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: false, 
                            message: "Không thể kết nối tới máy chủ CheckinX (Spring Boot có đang chạy ở port 8080 không?). Đặt phòng chưa được đồng bộ.",
                            error: err.message
                        }));
                        return;
                    }

                    console.log(`[Webhook] CheckinX Response Code: ${result.statusCode}, Body: ${result.body}`);

                    if (result.statusCode >= 200 && result.statusCode < 300) {
                        mockBookings.push(newBooking);
                        saveBookingsToFile();
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: true, 
                            message: "Đặt phòng thành công và đã đồng bộ sang hệ thống CheckinX!", 
                            booking: newBooking,
                            webhookResponse: JSON.parse(result.body || '{}')
                        }));
                    } else {
                        let errResponse = {};
                        try { errResponse = JSON.parse(result.body); } catch(e) {}
                        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ 
                            success: false, 
                            message: `Đồng bộ thất bại. Máy chủ CheckinX báo lỗi: ${errResponse.message || 'Hết phòng / Trùng lịch'}`,
                            details: errResponse
                        }));
                    }
                });

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: "Lỗi hệ thống: " + err.message }));
            }
        });
        return;
    }

    // 4. API lấy danh sách booking hiện tại
    if (req.method === 'GET' && pathname === '/api/bookings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockBookings));
        return;
    }

    // 5. API nhận danh sách ngày hết phòng từ CheckinX qua iCal
    if (req.method === 'GET' && pathname === '/api/blocked-dates') {
        const roomType = parsedUrl.query.roomType || 'STANDARD';
        
        let roomTypeId = 1; // Standard mặc định
        if (roomType.toUpperCase() === 'DELUXE') roomTypeId = 2;
        if (roomType.toUpperCase() === 'VIP') roomTypeId = 3;

        const localBlocked = [];
        const filtered = mockBookings.filter(b => normalizeRoomType(b.roomTypeCode) === roomType.toUpperCase() && b.status === "CONFIRMED");
        filtered.forEach(b => {
            let curr = new Date(b.checkIn);
            let end = new Date(b.checkOut);
            while (curr < end) {
                localBlocked.push(curr.toISOString().slice(0, 10));
                curr.setDate(curr.getDate() + 1);
            }
        });

        fetchAndParseCheckinxCalendar(roomTypeId, (err, systemBlocked) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
            if (err) {
                console.warn(`[Blocked Dates] Không kết nối được CheckinX cho loại phòng ID ${roomTypeId}. Dùng lịch local.`);
                res.end(JSON.stringify(localBlocked));
            } else {
                const mergedBlocked = Array.from(new Set([...systemBlocked, ...localBlocked]));
                res.end(JSON.stringify(mergedBlocked));
            }
        });
        return;
    }

    // 6. API nhận cập nhật trực tiếp từ CheckinX (Real-time Availability Push)
    if (req.method === 'PUT' && pathname.startsWith('/api/v1/ota/listings/')) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            console.log(`[API Push] Nhận cập nhật phòng từ CheckinX cho path: ${pathname}. Content: ${body}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: "success", message: "Đã nhận cập nhật phòng thành công!" }));
        });
        return;
    }

    // 404 Không tìm thấy
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
};

// Khởi động lắng nghe cổng khi chạy standalone (local)
if (require.main === module || !process.env.VERCEL) {
    const server = http.createServer(handler);
    server.listen(PORT, () => {
        console.log(`=======================================================`);
        console.log(`🚀 MÁY CHỦ AGODA MOCK ĐANG CHẠY TẠI: http://localhost:${PORT}`);
        console.log(`🔗 Link iCal Standard: http://localhost:${PORT}/api/v1/ota/calendar/standard.ics`);
        console.log(`🔗 Link iCal Suite:  http://localhost:${PORT}/api/v1/ota/calendar/vip.ics`);
        console.log(`🔗 Webhook đồng bộ:  ${CHECKINX_API_URL}`);
        console.log(`=======================================================`);
    });
}

module.exports = handler;

// HTML giao diện tích hợp trong file để dễ chạy
function getHTMLContent() {
    return `
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Kênh Giả Lập Agoda | Mock Channel Manager</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap');
        
        :root {
            --primary: #9b51e0;
            --primary-dark: #7b3db0;
            --success: #10b981;
            --danger: #ef4444;
            --dark-bg: #0f172a;
            --card-bg: #1e293b;
            --border-color: #334155;
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--dark-bg);
            color: var(--text-main);
            padding: 40px 20px;
            display: flex;
            justify-content: center;
        }

        .container {
            max-width: 1100px;
            width: 100%;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 30px;
        }

        @media (max-width: 768px) {
            .container {
                grid-template-columns: 1fr;
            }
        }

        header {
            grid-column: 1 / -1;
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: linear-gradient(135deg, #9b51e0, #4f3cc9);
            padding: 24px 32px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(79, 60, 201, 0.2);
            margin-bottom: 10px;
        }

        .logo h1 {
            font-size: 28px;
            font-weight: 800;
            letter-spacing: -0.5px;
        }

        .logo span {
            color: #d8b4fe;
        }

        .subtitle {
            font-size: 13px;
            background: rgba(255,255,255,0.15);
            padding: 4px 12px;
            border-radius: 20px;
            margin-top: 4px;
        }

        .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 16px;
            padding: 28px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        }

        h2 {
            font-size: 20px;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
            gap: 10px;
            color: #d8b4fe;
        }

        .form-group {
            margin-bottom: 18px;
        }

        label {
            display: block;
            font-size: 13.5px;
            font-weight: 500;
            margin-bottom: 6px;
            color: var(--text-muted);
        }

        input, select {
            width: 100%;
            background-color: #0f172a;
            border: 1px solid var(--border-color);
            color: var(--text-main);
            padding: 12px 16px;
            border-radius: 10px;
            font-family: inherit;
            font-size: 14px;
            outline: none;
            transition: all 0.2s;
        }

        input:focus, select:focus {
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(155, 81, 224, 0.25);
        }

        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 15px;
        }

        button {
            width: 100%;
            background: linear-gradient(135deg, #9b51e0, #7b3db0);
            color: white;
            border: none;
            padding: 14px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 10px;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 15px rgba(155, 81, 224, 0.4);
        }

        .booking-item {
            background-color: #131d31;
            border: 1px solid var(--border-color);
            border-radius: 10px;
            padding: 16px;
            margin-bottom: 12px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .booking-info h4 {
            font-size: 16px;
            color: var(--text-main);
            margin-bottom: 4px;
        }

        .booking-info p {
            font-size: 12px;
            color: var(--text-muted);
        }

        .status-badge {
            background-color: rgba(16, 185, 129, 0.15);
            color: var(--success);
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
        }

        /* Toast notifications */
        .toast {
            position: fixed;
            bottom: 24px;
            right: 24px;
            padding: 16px 24px;
            border-radius: 10px;
            color: white;
            font-weight: 500;
            box-shadow: 0 10px 25px rgba(0,0,0,0.3);
            display: none;
            z-index: 1000;
            animation: slideIn 0.3s ease-out;
        }

        @keyframes slideIn {
            from { transform: translateY(100px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
        }

        .feed-links {
            margin-top: 20px;
            padding: 16px;
            background-color: #0f172a;
            border-radius: 10px;
            border: 1px solid var(--border-color);
        }

        .feed-links a {
            color: #d8b4fe;
            text-decoration: none;
            word-break: break-all;
            font-size: 12px;
            display: block;
            margin-top: 6px;
        }
        .feed-links a:hover {
            text-decoration: underline;
        }

        /* Calendar Styling */
        .calendar-day {
            padding: 10px 0;
            text-align: center;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 500;
            transition: all 0.2s;
        }
        .calendar-day.free {
            background-color: #131d31;
            border: 1px solid var(--border-color);
            color: var(--text-main);
            cursor: pointer;
        }
        .calendar-day.free:hover {
            background-color: var(--primary-dark);
            border-color: var(--primary);
        }
        .calendar-day.blocked {
            background-color: rgba(239, 68, 68, 0.15);
            border: 1px solid var(--danger);
            color: var(--danger);
            text-decoration: line-through;
            cursor: not-allowed;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logo">
                <h1>AGODA<span>.mock</span></h1>
                <div class="subtitle">Giả lập OTA Channel Manager - Project Simulation</div>
            </div>
            <div style="text-align: right">
                <span class="status-badge" style="background-color: rgba(255,255,255,0.2); color: white;">
                     Online
                </span>
            </div>
        </header>

        <!-- Trái: Tạo đặt phòng -->
        <div class="card">
            <h2><i class="fa-solid fa-hotel"></i> Khách đặt phòng trực tuyến</h2>
            <form id="bookForm">
                <div class="form-group">
                    <label>Họ và Tên Khách Hàng</label>
                    <input type="text" id="guestName" placeholder="Ví dụ: Nguyễn Văn A" required>
                </div>
                <div class="grid-2">
                    <div class="form-group">
                        <label>Số điện thoại</label>
                        <input type="tel" id="guestPhone" placeholder="0912345678" required>
                    </div>
                    <div class="form-group">
                        <label>Email</label>
                        <input type="email" id="guestEmail" placeholder="guest@gmail.com" required>
                    </div>
                </div>
                <div class="form-group">
                    <label>Loại Phòng (Khớp với CheckinX Database)</label>
                    <select id="roomTypeCode" required>
                        <option value="STANDARD">STANDARD (400,000 VND/ngày)</option>
                    </select>
                </div>
                <div class="grid-2">
                    <div class="form-group">
                        <label>Ngày Check-In</label>
                        <input type="date" id="checkIn" required>
                    </div>
                    <div class="form-group">
                        <label>Ngày Check-Out</label>
                        <input type="date" id="checkOut" required>
                    </div>
                </div>
                <div class="form-group">
                    <label>Tổng số tiền (VND)</label>
                    <input type="number" id="amount" value="400000" required>
                </div>
                <button type="submit" id="btnSubmit">
                    <i class="fa-solid fa-credit-card"></i> Thanh toán & Đồng bộ Webhook
                </button>
            </form>

            <div class="feed-links">
                <label><i class="fa-solid fa-rss"></i> Đường dẫn iCal Feed của Agoda Mock:</label>
                <span style="font-size: 11px; color: var(--text-muted);">Dán link này vào cấu hình iCal của CheckinX để đồng bộ ngược:</span>
                <a href="/api/v1/ota/calendar/standard.ics" target="_blank" id="standardLink"></a>
            </div>
        </div>

        <!-- Phải: Lịch trống và Danh sách đặt phòng giả lập -->
        <div style="display: flex; flex-direction: column; gap: 20px;">
            <!-- Lịch tình trạng phòng -->
            <div class="card">
                <h2><i class="fa-solid fa-calendar-days"></i> Lịch Trống Agoda (Đồng bộ CheckinX)</h2>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <button id="btnPrevMonth" style="width: auto; padding: 6px 12px; font-size: 13px;"><i class="fa-solid fa-chevron-left"></i> Trước</button>
                    <span id="calendarMonthTitle" style="font-weight: 600; color: #d8b4fe; font-size: 16px;">Tháng -- / ----</span>
                    <button id="btnNextMonth" style="width: auto; padding: 6px 12px; font-size: 13px;">Kế <i class="fa-solid fa-chevron-right"></i></button>
                </div>
                <div style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; text-align: center; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px;">
                    <div>T2</div><div>T3</div><div>T4</div><div>T5</div><div>T6</div><div>T7</div><div>CN</div>
                </div>
                <div id="calendarDaysGrid" style="display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px;">
                    <!-- Ngày sẽ render ở đây -->
                </div>
                <div style="margin-top: 15px; display: flex; gap: 15px; font-size: 11px; justify-content: center;">
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <div style="width: 12px; height: 12px; background: #131d31; border: 1px solid var(--border-color); border-radius: 3px;"></div> Còn phòng
                    </div>
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <div style="width: 12px; height: 12px; background: rgba(239, 68, 68, 0.2); border: 1px solid var(--danger); border-radius: 3px;"></div> Hết phòng (CheckinX)
                    </div>
                </div>
            </div>

            <!-- Danh sách đặt phòng -->
            <div class="card" style="flex: 1; display: flex; flex-direction: column;">
                <h2><i class="fa-solid fa-list-check"></i> Đặt phòng trên Agoda Mock</h2>
                <div id="bookingList" style="flex: 1; overflow-y: auto; max-height: 250px; padding-right: 5px;">
                    <!-- Đặt phòng sẽ render ở đây -->
                </div>
            </div>
        </div>
    </div>

    <div id="toast" class="toast"></div>

    <script>
        const base = window.location.origin;
        document.getElementById('standardLink').href = base + '/api/v1/ota/calendar/standard.ics';
        document.getElementById('standardLink').innerText = base + '/api/v1/ota/calendar/standard.ics';

        async function fetchBookings() {
            try {
                const res = await fetch('/api/bookings');
                const data = await res.json();
                const container = document.getElementById('bookingList');
                container.innerHTML = '';
                
                if (data.length === 0) {
                    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding: 40px 0;">Chưa có lượt đặt phòng nào</div>';
                    return;
                }

                data.reverse().forEach(b => {
                    container.innerHTML += '<div class="booking-item">' +
                        '<div class="booking-info">' +
                            '<h4>' + b.guestName + '</h4>' +
                            '<p>Mã đặt phòng: <strong>' + b.bookingId + '</strong></p>' +
                            '<p>Loại phòng: ' + b.roomTypeCode + '</p>' +
                            '<p>Thời gian: ' + b.checkIn + ' đến ' + b.checkOut + '</p>' +
                            '<p>Thanh toán: ' + b.amount.toLocaleString() + ' VND</p>' +
                        '</div>' +
                        '<div>' +
                            '<span class="status-badge">' + b.status + '</span>' +
                        '</div>' +
                    '</div>';
                });
            } catch (err) {
                console.error("Lỗi lấy danh sách booking:", err);
            }
        }

        const roomPrices = {
            "STANDARD": 400000,
            "DELUXE": 750000,
            "VIP": 1500000
        };

        const roomSelect = document.getElementById('roomTypeCode');
        const amountInput = document.getElementById('amount');
        const checkInInput = document.getElementById('checkIn');
        const checkOutInput = document.getElementById('checkOut');

        function updatePrice() {
            const roomType = roomSelect.value;
            const pricePerNight = roomPrices[roomType] || 750000;
            
            const checkInVal = checkInInput.value;
            const checkOutVal = checkOutInput.value;
            
            if (checkInVal && checkOutVal) {
                const diffTime = Math.abs(new Date(checkOutVal) - new Date(checkInVal));
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                amountInput.value = (diffDays > 0 ? diffDays : 1) * pricePerNight;
                validateSelectedDates();
            } else {
                amountInput.value = pricePerNight;
            }
        }

        roomSelect.addEventListener('change', () => {
            updatePrice();
            fetchBlockedDates();
        });
        checkInInput.addEventListener('change', updatePrice);
        checkOutInput.addEventListener('change', updatePrice);

        let currentYear = 2026;
        let currentMonth = 5; 
        let blockedDates = [];

        async function fetchBlockedDates() {
            const roomType = roomSelect.value;
            try {
                const res = await fetch(\`/api/blocked-dates?roomType=\${roomType}\`);
                blockedDates = await res.json();
            } catch (e) {
                console.warn("Không thể tải lịch phòng bị khóa từ CheckinX:", e);
                blockedDates = [];
            }
            renderCalendar();
        }

        function renderCalendar() {
            const grid = document.getElementById('calendarDaysGrid');
            grid.innerHTML = '';

            const firstDay = new Date(currentYear, currentMonth, 1);
            const lastDay = new Date(currentYear, currentMonth + 1, 0);

            let startCol = firstDay.getDay() - 1;
            if (startCol < 0) startCol = 6;

            document.getElementById('calendarMonthTitle').innerText = 'Tháng ' + (currentMonth + 1).toString().padStart(2, '0') + ' / ' + currentYear;

            for (let i = 0; i < startCol; i++) {
                grid.innerHTML += \`<div style="padding: 10px 0; opacity: 0;"></div>\`;
            }

            const totalDays = lastDay.getDate();
            for (let day = 1; day <= totalDays; day++) {
                const dateObj = new Date(currentYear, currentMonth, day);
                const yyyy = dateObj.getFullYear();
                const mm = (dateObj.getMonth() + 1).toString().padStart(2, '0');
                const dd = dateObj.getDate().toString().padStart(2, '0');
                const actualDateStr = yyyy + '-' + mm + '-' + dd;

                const isBlocked = blockedDates.includes(actualDateStr);
                const dayClass = isBlocked ? "calendar-day blocked" : "calendar-day free";
                const titleAttr = isBlocked ? "Đã bán hết phòng trên CheckinX" : "Còn phòng trống";

                grid.innerHTML += '<div class="' + dayClass + '" title="' + titleAttr + '" onclick="selectDay(\\\'' + actualDateStr + '\\\', ' + isBlocked + ')">' + day + '</div>';
            }
        }

        window.selectDay = (dateStr, isBlocked) => {
            if (isBlocked) {
                showToast("Ngày này đã hết phòng trên CheckinX, không thể đặt!", "danger");
                return;
            }
            if (!checkInInput.value || (checkInInput.value && checkOutInput.value)) {
                checkInInput.value = dateStr;
                checkOutInput.value = '';
                showToast("Đã chọn ngày check-in: " + dateStr + ". Vui lòng chọn tiếp ngày check-out.", "success");
            } else {
                if (new Date(dateStr) <= new Date(checkInInput.value)) {
                    checkInInput.value = dateStr;
                    checkOutInput.value = '';
                    showToast("Đặt lại ngày check-in: " + dateStr, "success");
                } else {
                    checkOutInput.value = dateStr;
                    showToast("Đã chọn ngày check-out: " + dateStr, "success");
                    updatePrice();
                }
            }
        };

        function validateSelectedDates() {
            const checkInVal = checkInInput.value;
            const checkOutVal = checkOutInput.value;
            if (!checkInVal || !checkOutVal) return true;

            const start = new Date(checkInVal);
            const end = new Date(checkOutVal);

            if (start >= end) {
                showToast("Ngày check-out phải sau ngày check-in!", "danger");
                checkOutInput.value = '';
                return false;
            }

            let current = new Date(start);
            while (current < end) {
                const yyyy = current.getFullYear();
                const mm = (current.getMonth() + 1).toString().padStart(2, '0');
                const dd = current.getDate().toString().padStart(2, '0');
                const dateStr = yyyy + '-' + mm + '-' + dd;
                
                if (blockedDates.includes(dateStr)) {
                    showToast("Khoảng ngày bạn chọn chứa ngày đã bán hết phòng (" + dateStr + ")!", "danger");
                    checkInInput.value = '';
                    checkOutInput.value = '';
                    return false;
                }
                current.setDate(current.getDate() + 1);
            }
            return true;
        }

        document.getElementById('btnPrevMonth').addEventListener('click', () => {
            currentMonth--;
            if (currentMonth < 0) {
                currentMonth = 11;
                currentYear--;
            }
            renderCalendar();
        });

        document.getElementById('btnNextMonth').addEventListener('click', () => {
            currentMonth++;
            if (currentMonth > 11) {
                currentMonth = 0;
                currentYear++;
            }
            renderCalendar();
        });

        document.getElementById('bookForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!validateSelectedDates()) return;

            const btn = document.getElementById('btnSubmit');
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang thanh toán & đồng bộ...';

            const payload = {
                guestName: document.getElementById('guestName').value,
                guestPhone: document.getElementById('guestPhone').value,
                guestEmail: document.getElementById('guestEmail').value,
                roomTypeCode: document.getElementById('roomTypeCode').value,
                checkIn: document.getElementById('checkIn').value,
                checkOut: document.getElementById('checkOut').value,
                amount: document.getElementById('amount').value
            };

            try {
                const res = await fetch('/api/mock-book', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                const result = await res.json();
                if (res.ok && result.success) {
                    showToast(result.message, 'success');
                    document.getElementById('guestName').value = '';
                    document.getElementById('guestPhone').value = '';
                    document.getElementById('guestEmail').value = '';
                    document.getElementById('checkIn').value = '';
                    document.getElementById('checkOut').value = '';
                    fetchBookings();
                    fetchBlockedDates();
                } else {
                    showToast(result.message || 'Lỗi đặt phòng!', 'danger');
                }
            } catch (err) {
                showToast('Không thể kết nối đến máy chủ Agoda Mock hoặc CheckinX offline.', 'danger');
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fa-solid fa-credit-card"></i> Thanh toán & Đồng bộ Webhook';
            }
        });

        function showToast(msg, type) {
            const toast = document.getElementById('toast');
            toast.innerText = msg;
            toast.style.display = 'block';
            toast.style.backgroundColor = type === 'success' ? 'var(--success)' : 'var(--danger)';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 5000);
        }

        fetchBookings();
        fetchBlockedDates();
        setInterval(fetchBlockedDates, 30000);
    </script>
</body>
</html>
    `;
}
