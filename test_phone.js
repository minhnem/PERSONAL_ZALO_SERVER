import fetch from 'node-fetch';

const testFriendRequest = async () => {
  // Thay đổi 3 thông tin này theo ý bạn:
  const accountId = 'default'; // Hoặc sđt tài khoản người gửi (vd: '0912345678')
  const phoneNumbers = ['0393608151']; // Danh sách các số điện thoại muốn kết bạn
  const message = 'Chào {first_name}, mình kết bạn nhé!';

  console.log(`Đang gọi API gửi kết bạn cho ${phoneNumbers.length} số điện thoại...`);

  try {
    const response = await fetch('http://localhost:3000/api/send-friend-by-phone', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ accountId, phoneNumbers, message })
    });

    const result = await response.json();
    console.log('Kết quả từ Server:', result);
    
    if (result.success) {
      console.log('Bạn hãy xem log của Server Terminal để thấy quá trình Worker đang chạy ngầm gửi tin nhé!');
    }
  } catch (err) {
    console.error('Lỗi khi gọi API:', err.message);
  }
};

testFriendRequest();
