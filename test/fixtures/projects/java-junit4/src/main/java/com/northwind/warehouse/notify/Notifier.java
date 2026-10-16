package com.northwind.warehouse.notify;

/** Somewhere to send an alert: a chat channel, an email list, a pager. */
public interface Notifier {
    void send(String channel, String message);
}
