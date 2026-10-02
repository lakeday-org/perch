#include "cart.hpp"
#include <arpa/inet.h>
#include <gtest/gtest.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cstdlib>
#include <string>

TEST(ApplyDiscount, TakesTenPercentOff) {
    EXPECT_EQ(apply_discount(200, 10), 180);
}

TEST(ApplyDiscount, TakesTwentyPercentOff) {
    EXPECT_EQ(apply_discount(200, 20), 160);
}

TEST(ApplyDiscount, TakesTwentyFivePercentOff) {
    EXPECT_EQ(apply_discount(200, 25), 150);
}

TEST(ApplyDiscount, TakesFiftyPercentOff) {
    EXPECT_EQ(apply_discount(200, 50), 100);
}

TEST(ApplyDiscount, TakesSeventyFivePercentOff) {
    EXPECT_EQ(apply_discount(200, 75), 50);
}

TEST(Subtotal, AddsUpTheCart) {
    subtotal({{"book", 1, 20}, {"pen", 2, 3}});
}

TEST(Subtotal, MatchesThePriceServiceTotal) {
    const char* token = std::getenv("PRICE_SERVICE_TOKEN");
    ASSERT_NE(token, nullptr);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(7878);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    ASSERT_EQ(connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)), 0);
    std::string request = std::string("AUTH ") + token + "\nPRICE book\n";
    send(fd, request.data(), request.size(), 0);
    char reply[32] = {};
    recv(fd, reply, sizeof(reply) - 1, 0);
    close(fd);
    int unit_price = std::stoi(reply);
    EXPECT_EQ(subtotal({{"book", 2, unit_price}}), unit_price * 2);
}
