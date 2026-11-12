// Dijalankan sebelum modul aplikasi dimuat: variabel yang dibaca saat import harus sudah ada.
process.env.JWT_SECRET = "test-secret-test-secret-test-secret-1234";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.NODE_ENV = "test";
