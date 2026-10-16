#include "cart.hpp"
#include <arpa/inet.h>
#include <doctest/doctest.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cstdlib>
#include <string>

TEST_CASE("apply_discount takes ten percent off") {
    CHECK(apply_discount(200, 10) == 180);
}

TEST_CASE("apply_discount takes twenty percent off") {
    CHECK(apply_discount(200, 20) == 160);
}

TEST_CASE("apply_discount takes twenty-five percent off") {
    CHECK(apply_discount(200, 25) == 150);
}

TEST_CASE("apply_discount takes fifty percent off") {
    CHECK(apply_discount(200, 50) == 100);
}

TEST_CASE("apply_discount takes seventy-five percent off") {
    CHECK(apply_discount(200, 75) == 50);
}

TEST_CASE("subtotal adds up the cart") {
    subtotal({{"book", 1, 20}, {"pen", 2, 3}});
}

TEST_CASE("subtotal matches the price service total") {
    const char* token = std::getenv("PRICE_SERVICE_TOKEN");
    REQUIRE(token != nullptr);
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(7878);
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr);
    REQUIRE(connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0);
    std::string request = std::string("AUTH ") + token + "\nPRICE book\n";
    send(fd, request.data(), request.size(), 0);
    char reply[32] = {};
    recv(fd, reply, sizeof(reply) - 1, 0);
    close(fd);
    int unit_price = std::stoi(reply);
    CHECK(subtotal({{"book", 2, unit_price}}) == unit_price * 2);
}
